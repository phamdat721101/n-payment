import type { PaymentAdapter } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { NPaymentError } from '../errors.js';

/**
 * MPP adapter — delegates to mppx with a proper viem account for real on-chain Tempo transactions.
 *
 * mppx handles all Tempo-specific logic internally:
 * - Custom transaction serializers (Tempo chain)
 * - Expiring transactions (validBefore)
 * - Push/pull payment modes
 * - EIP-712 typed data signing for proof challenges
 */
export class MppAdapter implements PaymentAdapter {
  readonly protocol = 'mpp';
  private mppxInstance: any = null;
  private wallet: OWSWallet;

  constructor(wallet: OWSWallet) {
    this.wallet = wallet;
  }

  private async getMppx() {
    if (this.mppxInstance) return this.mppxInstance;

    const { Mppx, tempo } = await import('mppx/client');
    const account = this.wallet.getAccount();

    if (!account) {
      throw new NPaymentError(
        'MPP requires a privateKey for Tempo transaction signing',
        'MPP_NO_ACCOUNT',
        'Provide ows.privateKey in config — mppx needs a full viem account for signTypedData and signTransaction',
      );
    }

    this.mppxInstance = Mppx.create({
      polyfill: false,
      methods: [tempo({ account })],
    });
    return this.mppxInstance;
  }

  detect(response: Response): boolean {
    return response.headers.get('www-authenticate')?.toLowerCase().includes('payment') ?? false;
  }

  async pay(url: string, init: RequestInit | undefined, _response: Response): Promise<Response> {
    const mppx = await this.getMppx();
    return mppx.fetch(url, init);
  }
}
