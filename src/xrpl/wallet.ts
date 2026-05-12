import { NPaymentError } from '../errors.js';
import type { XrplConfig } from '../types.js';

export interface XrplWalletConfig {
  seed?: string;
  owsWallet?: string;
}

export class XrplWallet {
  private seed?: string;
  private owsWallet?: string;
  private walletInstance: any = null;

  constructor(config: XrplWalletConfig) {
    this.seed = config.seed;
    this.owsWallet = config.owsWallet;
    if (!this.seed && !this.owsWallet) {
      throw new NPaymentError('XrplWallet requires seed or owsWallet', 'XRPL_NO_CREDENTIALS');
    }
  }

  private async getWalletInstance() {
    if (this.walletInstance) return this.walletInstance;
    const { Wallet } = await import('xrpl');
    if (this.seed) {
      this.walletInstance = Wallet.fromSeed(this.seed);
    } else if (this.owsWallet) {
      // OWS mode: derive from OWS-managed XRPL key
      const ows = await import('@open-wallet-standard/core');
      const wallet = ows.getWallet(this.owsWallet);
      const xrplAccount = wallet.accounts.find((a: any) => a.chainId?.startsWith('xrpl:'));
      if (!xrplAccount) throw new NPaymentError('No XRPL account in OWS wallet', 'XRPL_OWS_NO_ACCOUNT');
      this.walletInstance = { address: xrplAccount.address, classicAddress: xrplAccount.address };
    }
    return this.walletInstance;
  }

  async getAddress(): Promise<string> {
    const w = await this.getWalletInstance();
    return w.classicAddress ?? w.address;
  }

  async sign(transaction: Record<string, any>): Promise<{ tx_blob: string; hash: string }> {
    const w = await this.getWalletInstance();
    if (w.sign) return w.sign(transaction);
    // OWS signing fallback
    if (this.owsWallet) {
      const ows = await import('@open-wallet-standard/core');
      const result = await ows.signAndSend(this.owsWallet, 'xrpl:testnet', JSON.stringify(transaction));
      return { tx_blob: '', hash: result.txHash };
    }
    throw new NPaymentError('Cannot sign: no signing capability', 'XRPL_SIGN_FAILED');
  }
}
