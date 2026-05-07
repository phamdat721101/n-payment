import type { PaymentAdapter, ChainKey } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { CHAINS } from '../chains.js';
import { TestnetFaucet } from '../faucet.js';
import { NPaymentError } from '../errors.js';

export class MppAdapter implements PaymentAdapter {
  readonly protocol = 'mpp';
  private mppxInstance: any = null;
  private wallet: OWSWallet;
  private chainKey: ChainKey;
  private autoFaucet: boolean;

  constructor(wallet: OWSWallet, chainKey: ChainKey, autoFaucet = false) {
    this.wallet = wallet;
    this.chainKey = chainKey;
    this.autoFaucet = autoFaucet;
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

    if (this.autoFaucet) {
      const chain = CHAINS[this.chainKey];
      const faucet = new TestnetFaucet(chain);
      await faucet.ensureFunded(account.address, chain.tokens.PathUSD ?? chain.tokens.USDC ?? '');
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
