import type { PaymentAdapter, ChainKey } from '../types.js';
import { StellarWallet } from '../stellar/wallet.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';

/**
 * Stellar MPP adapter.
 * Flow: detect MPP challenge → sign SAC transfer → submit (push mode) → retry with tx hash.
 */
export class StellarMppAdapter implements PaymentAdapter {
  readonly protocol = 'stellar-mpp';
  private wallet: StellarWallet;
  private chainKey: ChainKey;

  constructor(wallet: StellarWallet, chainKey: ChainKey) {
    this.wallet = wallet;
    this.chainKey = chainKey;
  }

  detect(response: Response): boolean {
    const auth = response.headers.get('www-authenticate') ?? '';
    return auth.toLowerCase().includes('payment') && auth.toLowerCase().includes('stellar');
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const chain = CHAINS[this.chainKey];
    const auth = response.headers.get('www-authenticate') ?? '';

    // Parse MPP challenge: amount, recipient, currency from WWW-Authenticate header
    const amount = this.extractParam(auth, 'amount') ?? '0.01';
    const recipient = this.extractParam(auth, 'recipient') ?? '';
    if (!recipient) throw new NPaymentError('No recipient in Stellar MPP challenge', 'STELLAR_MPP_NO_RECIPIENT');

    // Try using @stellar/mpp SDK if available, otherwise manual SAC transfer
    try {
      const mpp = await import('@stellar/mpp');
      const publicKey = await this.wallet.getPublicKey();
      // Use charge client in push mode
      const credential = await mpp.createChargeCredential({
        from: publicKey,
        to: recipient,
        amount,
        asset: chain.tokens.USDC,
        network: chain.caip2,
      });

      const signedXdr = await this.wallet.signTransaction(credential.unsignedXdr, this.getPassphrase());

      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set('authorization', `Payment ${signedXdr}`);
      retryHeaders.set('x-payment-network', chain.caip2);
      return fetch(url, { ...init, headers: retryHeaders });
    } catch {
      // Fallback: manual auth entry signing
      const publicKey = await this.wallet.getPublicKey();
      const payload = JSON.stringify({ from: publicKey, to: recipient, amount, asset: chain.tokens.USDC });
      const signature = await this.wallet.signAuthEntry(Buffer.from(payload).toString('base64'));

      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set('authorization', `Payment ${signature}`);
      retryHeaders.set('x-payment-from', publicKey);
      retryHeaders.set('x-payment-network', chain.caip2);
      return fetch(url, { ...init, headers: retryHeaders });
    }
  }

  private getPassphrase(): string {
    return this.chainKey === 'stellar-mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';
  }

  private extractParam(header: string, key: string): string | undefined {
    const match = header.match(new RegExp(`${key}="([^"]+)"`));
    return match?.[1];
  }
}
