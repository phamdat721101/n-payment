import type { PaymentAdapter } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';

/**
 * MPP adapter — delegates to mppx with OWS-backed signing.
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
    const address = await this.wallet.getAddress(2) as `0x${string}`;
    const w = this.wallet;

    const owsAccount = {
      address,
      async signMessage({ message }: { message: any }) {
        const msg = typeof message === 'string' ? message : typeof message?.raw === 'string' ? message.raw : String(message);
        return w.signMessage(msg) as Promise<`0x${string}`>;
      },
      async signTransaction(tx: any) {
        const result = await w.signTransaction(tx, 2);
        return result.signedTx as `0x${string}`;
      },
      type: 'local' as const,
      source: 'custom' as const,
      publicKey: '0x' as `0x${string}`,
      signTypedData: async () => '0x' as `0x${string}`,
    } as any;

    this.mppxInstance = Mppx.create({
      polyfill: false,
      methods: [tempo({ account: owsAccount })],
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
