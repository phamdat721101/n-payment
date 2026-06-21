import type { PaymentAdapter, PaymentContext } from '../types.js';
import type { XrplWallet } from '../xrpl/wallet.js';
import type { XrplConnection } from '../xrpl/connection.js';
import type { XrplSwapClient } from '../xrpl/swap.js';
import type { XrplTreasuryManager } from '../xrpl/treasury.js';
import {
  ensureTrustline,
  readAccountState,
  buildXrplRlusdPaymentTx,
  invalidateAccountState,
} from '../xrpl/payments.js';
import {
  DEFAULT_SOURCE_TAG,
  formatRlusdAmount,
  getRlusdIssuer,
  parseCaip2,
  parseRlusdAmount,
  RLUSD_HEX,
  toCaip2,
  type XrplNetwork,
} from '../xrpl/utils.js';
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  type XrplPaymentRequirements,
} from '../xrpl/x402-scheme.js';
import { NPaymentError } from '../errors.js';

export interface XrplAdapterOptions {
  /** Auto-swap XRP→RLUSD when the buyer is short. @default false */
  autoSwap?: boolean;
  /** Max acceptable slippage on auto-swap, in bps. @default 100 (1%) */
  maxSlippageBps?: number;
  /** Override the SourceTag stamped on every Payment. @default 804681468 (T54 indexer). */
  sourceTag?: number;
}

/**
 * XRPL x402 adapter — canonical T54 / xrpl.org spec.
 *
 * Wire format (https://xrpl-x402.t54.ai/docs/xrpl-scheme):
 *   server  → client : PAYMENT-REQUIRED   (base64-JSON challenge)
 *   client  → server : PAYMENT-SIGNATURE  (base64-JSON {accepted, payload.signedTxBlob})
 *   server  → client : PAYMENT-RESPONSE   (base64-JSON settlement record)
 *
 * The buyer never submits the tx itself; it presigns a Payment with
 * {SourceTag, MemoData=hex(invoiceId), LastLedgerSequence}, and the merchant's
 * facilitator does verify+settle.
 *
 * Sequence (per-wallet serialised by an address mutex):
 *   ensureTrustLine → readAccountState → (treasury rescue) → (swap rescue) →
 *   buildXrplRlusdPaymentTx → wallet.sign → PAYMENT-SIGNATURE retry.
 *
 * RLUSD-first: XRP-asset challenges throw `XRPL_X402_XRP_PENDING` (follow-up).
 */
export class XrplAdapter implements PaymentAdapter {
  readonly protocol = 'xrpl';
  /** Per-address mutex — prevents concurrent double-swap on parallel calls. */
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
    const header = readHeader(response.headers, 'PAYMENT-REQUIRED');
    if (!header) return false;
    try {
      const env = decodePaymentRequiredHeader(header);
      const a = env.accepts[0];
      // Only handle XRPL networks; only accept XRP or RLUSD asset references.
      if (!a.network.startsWith('xrpl:')) return false;
      const asset = a.asset.toUpperCase();
      return asset === 'XRP' || asset === 'RLUSD' || asset === RLUSD_HEX;
    } catch {
      return false;
    }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response, ctx?: PaymentContext): Promise<Response> {
    const address = await this.wallet.getAddress();
    const previous = this.locks.get(address) ?? Promise.resolve();
    const work = previous.then(
      () => this.payLocked(url, init, response, ctx),
      () => this.payLocked(url, init, response, ctx),
    );
    this.locks.set(address, work);
    try {
      return (await work) as Response;
    } finally {
      if (this.locks.get(address) === work) this.locks.delete(address);
    }
  }

  // ─── Locked critical section ───────────────────────────────────────────────

  private async payLocked(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    _ctx?: PaymentContext,
  ): Promise<Response> {
    const accepted = this.parseChallenge(response);

    // RLUSD-first: XRP path is scaffolded for the follow-up PR.
    if (accepted.asset === 'XRP') {
      throw new NPaymentError(
        'XRP-asset XRPL x402 not yet supported (RLUSD-first).',
        'XRPL_X402_XRP_PENDING',
        'Use an RLUSD-priced endpoint, or wait for the XRP-drops follow-up.',
      );
    }

    const issuer = accepted.extra.issuer ?? getRlusdIssuer(this.network);
    const fromAddress = await this.wallet.getAddress();

    // 1. Trust line (idempotent — cached + mutex-coalesced; sibling to the merchant preflight).
    await ensureTrustline(this.connection, {
      address: fromAddress,
      issuer,
      signer: this.wallet,
    });

    // 2. Read balance once; rescue (treasury then swap) if short.
    let state = await readAccountState(this.connection, fromAddress, { issuer });
    const need = parseRlusdAmount(accepted.amount);

    if (this.treasury?.isEnabled() && parseRlusdAmount(state.rlusdBalance) < need) {
      try {
        await this.treasury.ensureLiquid(accepted.amount);
        state = await readAccountState(this.connection, fromAddress, { issuer, fresh: true });
      } catch (err) {
        if (!this.options.autoSwap) throw err;
      }
    }

    if (parseRlusdAmount(state.rlusdBalance) < need) {
      if (!this.options.autoSwap || !this.swap) {
        throw new NPaymentError(
          `Insufficient RLUSD: have ${formatRlusdAmount(parseRlusdAmount(state.rlusdBalance))}, need ${accepted.amount}`,
          'XRPL_INSUFFICIENT_BALANCE',
          'Enable xrpl.autoSwap or pre-fund the wallet with RLUSD.',
        );
      }
      const shortfall = formatRlusdAmount(need - parseRlusdAmount(state.rlusdBalance));
      await this.swap.swap({
        from: 'XRP',
        to: 'RLUSD',
        amountOut: shortfall,
        maxSlippageBps: this.options.maxSlippageBps ?? 100,
      });
      // Invalidate cached state so subsequent (queued) calls see the new balance.
      invalidateAccountState(fromAddress);
    }

    // 3. Build presigned Payment + sign.
    const tx = await buildXrplRlusdPaymentTx(this.connection, {
      fromAddress,
      payTo: accepted.payTo,
      amount: accepted.amount,
      issuer,
      invoiceId: accepted.extra.invoiceId,
      sourceTag: this.options.sourceTag ?? accepted.extra.sourceTag ?? DEFAULT_SOURCE_TAG,
      destinationTag: accepted.extra.destinationTag,
    });
    const signed = await this.wallet.sign(tx);
    if (!signed.tx_blob) {
      throw new NPaymentError(
        'Wallet did not return a signed tx_blob',
        'XRPL_SIGN_FAILED',
        'OWS-only signers must produce a tx_blob; use seed-mode for the buyer flow.',
      );
    }

    // 4. Retry HTTP with canonical PAYMENT-SIGNATURE header.
    const sigHeader = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: { signedTxBlob: signed.tx_blob },
    });
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('PAYMENT-SIGNATURE', sigHeader);
    const finalResponse = await fetch(url, { ...init, headers: retryHeaders });

    // 5. Fire-and-forget treasury sweep (debounced inside the manager).
    this.treasury?.scheduleSweep();

    return finalResponse;
  }

  // ─── Challenge parsing ─────────────────────────────────────────────────────

  private parseChallenge(response: Response): XrplPaymentRequirements {
    const header = readHeader(response.headers, 'PAYMENT-REQUIRED');
    if (!header) {
      throw new NPaymentError('Missing PAYMENT-REQUIRED header', 'XRPL_X402_MISSING_HEADER');
    }
    const env = decodePaymentRequiredHeader(header);
    const a = { ...env.accepts[0] };

    // Asset normalisation — accept the soft "RLUSD" symbol but echo the
    // canonical 40-hex code in the PAYMENT-SIGNATURE.accepted body.
    if (a.asset === 'RLUSD') a.asset = RLUSD_HEX;

    // Network sanity — fail fast if the merchant advertises a different
    // CAIP-2 than the adapter is configured for.
    const challengeNetwork = parseCaip2(a.network);
    if (challengeNetwork !== this.network) {
      throw new NPaymentError(
        `Network mismatch: adapter=${toCaip2(this.network)}, challenge=${a.network}`,
        'XRPL_X402_NETWORK_MISMATCH',
        'Configure the adapter for the same XRPL network the merchant is on.',
      );
    }
    return a;
  }
}

/** Case-insensitive header read (Node's Headers preserves case but the spec is uppercase). */
function readHeader(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
}
