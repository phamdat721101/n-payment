import type { PaymentAdapter, PaymentContext } from '../types.js';
import type { XrplWallet } from '../xrpl/wallet.js';
import type { XrplConnection } from '../xrpl/connection.js';
import type { XrplSwapClient } from '../xrpl/swap.js';
import type { XrplTreasuryManager } from '../xrpl/treasury.js';
import { ensureTrustLine, sendRLUSD, readAccountState } from '../xrpl/payments.js';
import { getRlusdIssuer, parseRlusdAmount, formatRlusdAmount, type XrplNetwork } from '../xrpl/utils.js';
import { NPaymentError } from '../errors.js';

export interface XrplAdapterOptions {
  autoSwap?: boolean;
  maxSlippageBps?: number;
}

interface PaywallChallenge {
  payTo: string;
  amount: string;
  network: string;
}

/**
 * v0.14 XRPL 402 adapter.
 *
 * Sequence (per-wallet serialised):
 *   ensureTrustLine → readAccountState → (treasury.ensureLiquid) →
 *   (swap if still short) → sendRLUSD → schedule sweep → retry HTTP
 */
export class XrplAdapter implements PaymentAdapter {
  readonly protocol = 'xrpl';
  /** Per-address mutex — fixes Gstack Q2 (concurrent double-swap). */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly wallet: XrplWallet,
    private readonly connection: XrplConnection,
    private readonly network: XrplNetwork,
    private readonly swap?: XrplSwapClient,
    private readonly treasury?: XrplTreasuryManager,
    private readonly options: XrplAdapterOptions = {},
  ) {}

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? '';
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      return decoded.accepts?.[0]?.network?.startsWith('xrpl:') ?? false;
    } catch { return false; }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response, ctx?: PaymentContext): Promise<Response> {
    const address = await this.wallet.getAddress();
    const previous = this.locks.get(address) ?? Promise.resolve();
    const work = previous.then(
      () => this.payLocked(url, init, response, ctx),
      // Don't propagate prior errors into our slot.
      () => this.payLocked(url, init, response, ctx),
    );
    this.locks.set(address, work);
    try {
      return (await work) as Response;
    } finally {
      // Drop the slot only if we're still the head.
      if (this.locks.get(address) === work) this.locks.delete(address);
    }
  }

  private async payLocked(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    _ctx?: PaymentContext,
  ): Promise<Response> {
    const challenge = this.parseChallenge(response);
    const issuer = getRlusdIssuer(this.network);
    const address = await this.wallet.getAddress();

    await ensureTrustLine(this.connection, this.wallet, { issuer });

    let state = await readAccountState(this.connection, address, { issuer });
    const need = parseRlusdAmount(challenge.amount);

    // 1. Treasury rescue (when configured).
    if (this.treasury?.isEnabled() && parseRlusdAmount(state.rlusdBalance) < need) {
      try {
        await this.treasury.ensureLiquid(challenge.amount);
        state = await readAccountState(this.connection, address, { issuer, fresh: true });
      } catch (err) {
        if (!this.options.autoSwap) throw err;
        // else fall through to swap rescue
      }
    }

    // 2. Swap rescue (when configured).
    let liquidUnits = parseRlusdAmount(state.rlusdBalance);
    if (liquidUnits < need) {
      if (!this.options.autoSwap || !this.swap) {
        throw new NPaymentError(
          `Insufficient RLUSD: have ${formatRlusdAmount(liquidUnits)}, need ${challenge.amount}`,
          'XRPL_INSUFFICIENT_BALANCE',
          'Enable xrpl.autoSwap or pre-fund the wallet with RLUSD.',
        );
      }
      const shortfall = formatRlusdAmount(need - liquidUnits);
      const intentId = makeIntentId();
      console.info(
        `[n-payment][xrpl] swap intent ${intentId}: XRP→${shortfall} RLUSD ` +
        `(network=${this.network}, payTo=${challenge.payTo})`,
      );
      try {
        await this.swap.swap({
          from: 'XRP',
          to: 'RLUSD',
          amountOut: shortfall,
          maxSlippageBps: this.options.maxSlippageBps ?? 100,
        });
      } catch (err) {
        // Re-throw with intent ID for operational tracing (Q3 idempotency log).
        if (err instanceof NPaymentError) throw err;
        throw new NPaymentError(
          `Swap failed (intent ${intentId}): ${(err as Error).message}`,
          'XRPL_SWAP_FAILED',
          'Re-call fetchWithPayment to retry; the intent ID is logged.',
        );
      }
    }

    // 3. Settle paywall.
    const { hash } = await sendRLUSD(this.connection, this.wallet, challenge.payTo, challenge.amount, { issuer });

    // 4. Retry HTTP with payment proof.
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-tx', hash);
    retryHeaders.set('x-payment-network', `xrpl:${this.network}`);
    const finalResponse = await fetch(url, { ...init, headers: retryHeaders });

    // 5. Fire-and-forget sweep — non-blocking, debounced inside treasury.
    this.treasury?.scheduleSweep();

    return finalResponse;
  }

  private parseChallenge(response: Response): PaywallChallenge {
    const header = response.headers.get('payment-required') ?? '';
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    const accepts = decoded.accepts?.[0] ?? {};
    const payTo = accepts.payTo;
    if (!payTo) throw new NPaymentError('No payTo in XRPL payment challenge', 'XRPL_MISSING_PAY_TO');
    return {
      payTo,
      amount: accepts.maxAmountRequired ?? '1',
      network: accepts.network ?? `xrpl:${this.network}`,
    };
  }
}

function makeIntentId(): string {
  return `swap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
