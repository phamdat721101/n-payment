import type { PaymentAdapter, ChainKey } from '../types.js';
import { StellarWallet } from '../stellar/wallet.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';

/**
 * Stellar x402 adapter.
 * Flow: parse 402 → sign Soroban auth entry → submit to facilitator → retry with proof.
 */
export class StellarX402Adapter implements PaymentAdapter {
  readonly protocol = 'stellar-x402';
  private wallet: StellarWallet;
  private chainKey: ChainKey;

  constructor(wallet: StellarWallet, chainKey: ChainKey) {
    this.wallet = wallet;
    this.chainKey = chainKey;
  }

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? '';
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      return decoded.accepts?.[0]?.network?.startsWith('stellar:') ?? false;
    } catch {
      return false;
    }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const chain = CHAINS[this.chainKey];
    const header = response.headers.get('payment-required') ?? '';
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    const accepts = decoded.accepts?.[0] ?? {};

    const payTo = accepts.payTo;
    const amount = accepts.maxAmountRequired ?? '10000';
    if (!payTo) throw new NPaymentError('No payTo in Stellar x402 challenge', 'STELLAR_X402_MISSING_PAY_TO');

    // Build Soroban SAC transfer auth entry and sign
    const publicKey = await this.wallet.getPublicKey();
    const authPayload = JSON.stringify({ from: publicKey, to: payTo, amount, asset: chain.tokens.USDC });
    const signature = await this.wallet.signAuthEntry(Buffer.from(authPayload).toString('base64'));

    // Submit to facilitator for verification and settlement
    const facilitator = chain.facilitator;
    if (facilitator) {
      const settleRes = await fetch(`${facilitator}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: 2,
          network: chain.caip2,
          payload: authPayload,
          signature,
          from: publicKey,
        }),
      });
      if (!settleRes.ok) throw new NPaymentError('Stellar x402 settlement failed', 'STELLAR_X402_SETTLE_FAILED');
    }

    // Retry original request with payment proof
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-signature', signature);
    retryHeaders.set('x-payment-network', chain.caip2);
    retryHeaders.set('x-payment-from', publicKey);
    return fetch(url, { ...init, headers: retryHeaders });
  }
}
