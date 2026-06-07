import type { Address } from 'viem';
import { CHAINS } from '../chains.js';
import { ChallengeParseError, NPaymentError } from '../errors.js';
import type { OWSWallet } from '../ows/wallet.js';
import type { ChainKey, PaymentAdapter, PaymentContext } from '../types.js';

/**
 * v0.22 — RLUSD `exact` scheme adapter (PRD-D Primitive A).
 *
 * The buyer broadcasts a real on-chain `RLUSD.transfer(merchant, amount)` and
 * submits the resulting tx hash as the X-PAYMENT proof. The merchant verifies
 * on-chain by reading the Transfer event log — **no facilitator dependency**.
 *
 * Why this exists: Coinbase CDP facilitator covers Base + Polygon + Arbitrum +
 * World + Solana — NOT Ethereum/Optimism/Ink/Unichain — and never RLUSD. RLUSD
 * does not implement EIP-3009 `transferWithAuthorization` per Ripple's
 * RLUSD-on-Ethereum design doc. Therefore: direct transfer + on-chain proof.
 *
 * SOLID — SRP: parse 402 → broadcast transfer → encode proof. Verification
 * lives in `middleware.ts::verifyExactRlusdPayment`.
 */
export class RlusdExactAdapter implements PaymentAdapter {
  readonly protocol = 'rlusd-exact';
  private readonly chainKey: ChainKey;

  constructor(
    private readonly wallet: OWSWallet,
    chainKey: ChainKey,
  ) {
    this.chainKey = chainKey;
  }

  detect(response: Response): boolean {
    const headerStr =
      response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
    if (!headerStr) return false;
    try {
      const decoded = JSON.parse(Buffer.from(headerStr, 'base64').toString());
      const accept = decoded.accepts?.[0];
      return (
        accept?.scheme === 'exact' &&
        // asset is the RLUSD ERC-20 OR symbol 'RLUSD'
        (accept?.asset === 'RLUSD' ||
          accept?.asset?.toLowerCase?.() === CHAINS[this.chainKey]?.tokens?.RLUSD?.toLowerCase())
      );
    } catch {
      return false;
    }
  }

  async pay(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    _ctx?: PaymentContext,
  ): Promise<Response> {
    const chain = CHAINS[this.chainKey];
    const rlusd = chain.tokens.RLUSD as Address | undefined;
    if (!rlusd) {
      throw new NPaymentError(
        `RLUSD not registered on ${this.chainKey}`,
        'RLUSD_EXACT_ASSET_MISSING',
        `Add RLUSD to chains.ts tokens or pick a different chain.`,
      );
    }

    const headerStr =
      response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
    if (!headerStr) {
      throw new ChallengeParseError('Missing payment-required header', 'MISSING_HEADER');
    }
    let accept: { payTo?: string; maxAmountRequired?: string; asset?: string; network?: string };
    try {
      const decoded = JSON.parse(Buffer.from(headerStr, 'base64').toString());
      accept = decoded.accepts?.[0] ?? {};
    } catch {
      throw new ChallengeParseError('Malformed payment-required header', 'INVALID_HEADER');
    }
    const payTo = accept.payTo as Address | undefined;
    const amountStr = accept.maxAmountRequired;
    if (!payTo || !amountStr) {
      throw new ChallengeParseError(
        'Missing payTo / maxAmountRequired in challenge',
        'INVALID_HEADER',
      );
    }
    const amount = BigInt(amountStr);

    // Broadcast on-chain RLUSD transfer using OWSWallet's public API.
    const tx = await this.wallet.transferERC20(payTo, rlusd, amount, chain.chainId);
    const fromAddr = await this.wallet.getAddressAsync(chain.chainId);

    const proof = Buffer.from(
      JSON.stringify({
        scheme: 'exact',
        network: accept.network ?? chain.caip2,
        txHash: tx.txHash,
        from: fromAddr,
        to: payTo,
        value: amountStr,
        asset: rlusd,
      }),
    ).toString('base64');

    const headers = new Headers(init?.headers);
    headers.set('x-payment', proof);
    return fetch(url, { ...init, headers });
  }
}
