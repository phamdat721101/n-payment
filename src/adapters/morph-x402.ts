import type { PaymentAdapter, PaymentContext, ChainKey } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { MorphX402Client } from '../morph/client.js';
import { CHAINS } from '../chains.js';
import { ChallengeParseError, InsufficientBalanceError, NPaymentError } from '../errors.js';

/**
 * Morph x402 adapter — single responsibility: orchestrate the Morph payment flow.
 *
 * Flow:
 *   1. Parse 402 challenge → extract paymentRequirements (network, asset, amount, payTo)
 *   2. Pre-check USDC balance (fail-fast)
 *   3. (Optional) facilitator.verify() — short-circuit if requirements invalid
 *   4. On-chain transfer via OWSWallet.transferERC20
 *   5. facilitator.settle() — get final tx hash, network from facilitator
 *   6. Retry original request with x-payment-tx + x-payment-network + x-payment-reference-key
 *
 * Routing: chain-config-driven (detect() inspects the 402 network field).
 */
export class MorphX402Adapter implements PaymentAdapter {
  readonly protocol = 'morph-x402';

  constructor(
    private readonly wallet: OWSWallet,
    private readonly client: MorphX402Client,
    private readonly chainKey: ChainKey,
  ) {}

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const network = decoded?.accepts?.[0]?.network as string | undefined;
      return network === CHAINS[this.chainKey].caip2;
    } catch {
      return false;
    }
  }

  async pay(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    ctx?: PaymentContext,
  ): Promise<Response> {
    const requirements = this.parseRequirements(response);
    const chain = CHAINS[this.chainKey];
    const asset = requirements.asset || chain.tokens.USDC;
    const amount = BigInt(requirements.maxAmountRequired);

    // 1. Balance pre-check (fail-fast, no facilitator call needed yet)
    const balance = await this.wallet.getBalance(asset, chain.chainId);
    if (balance < amount) {
      throw new InsufficientBalanceError(
        `Insufficient ${asset} on ${chain.name}: have ${balance}, need ${amount}`,
        'INSUFFICIENT_BALANCE',
        `Fund wallet on ${chain.name} (chainId ${chain.chainId})`,
      );
    }

    // 2. Build payment payload (x402 v2 envelope; settle flow uses tx hash post-transfer)
    const fromAddress = await this.wallet.getAddressAsync(chain.chainId);
    const payload = {
      x402Version: 2,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: { from: fromAddress, to: requirements.payTo, amount: amount.toString(), asset },
    };

    // 3. Verify (optional but recommended — catches invalid requirements before on-chain spend)
    const verifyRes = await this.client.verify(payload, requirements);
    if (!verifyRes.isValid) {
      throw new NPaymentError(
        `Morph verify rejected payment: ${verifyRes.invalidReason ?? 'unknown'}`,
        'MORPH_VERIFY_FAILED',
      );
    }

    // 4. On-chain transfer (OWSWallet handles signing)
    const { txHash } = await this.wallet.transferERC20(
      requirements.payTo,
      asset,
      amount,
      chain.chainId,
    );

    // 5. Settle — facilitator records the on-chain settlement (with our tx hash in payload)
    const settledPayload = { ...payload, payload: { ...payload.payload, transaction: txHash } };
    const settleRes = await this.client.settle(settledPayload, requirements);
    if (!settleRes.success) {
      throw new NPaymentError(
        `Morph settle failed (tx ${txHash}): ${settleRes.errorReason ?? 'unknown'}`,
        'MORPH_SETTLE_FAILED',
        'Payment was sent on-chain but facilitator did not confirm. Retry with same tx hash.',
      );
    }

    // 6. Retry with proof + reference key (forwards merchant order tracking)
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-tx', settleRes.transaction ?? txHash);
    retryHeaders.set('x-payment-network', settleRes.network ?? chain.caip2);
    if (settleRes.payer) retryHeaders.set('x-payment-payer', settleRes.payer);
    if (ctx?.referenceKey) retryHeaders.set('x-payment-reference-key', ctx.referenceKey);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  /** Parse the x402 v2 challenge envelope from the 402 response. */
  private parseRequirements(response: Response): {
    scheme: string;
    network: string;
    asset: string;
    maxAmountRequired: string;
    payTo: string;
  } {
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) {
      throw new ChallengeParseError('Missing payment-required header', 'MORPH_NO_CHALLENGE');
    }
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const accepts = decoded?.accepts?.[0];
      if (!accepts?.payTo || !accepts?.maxAmountRequired) {
        throw new Error('challenge missing payTo or maxAmountRequired');
      }
      return {
        scheme: String(accepts.scheme ?? 'exact'),
        network: String(accepts.network),
        asset: String(accepts.asset ?? ''),
        maxAmountRequired: String(accepts.maxAmountRequired),
        payTo: String(accepts.payTo),
      };
    } catch (err) {
      throw new ChallengeParseError(
        `Invalid Morph payment-required header: ${(err as Error).message}`,
        'MORPH_BAD_CHALLENGE',
      );
    }
  }
}
