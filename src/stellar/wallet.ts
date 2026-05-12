import { NPaymentError } from '../errors.js';

export interface StellarWalletConfig {
  secretKey?: string;
  publicKey?: string;
}

/**
 * Lightweight Stellar wallet abstraction.
 * Uses @stellar/stellar-sdk via dynamic import (optional peer dep).
 */
export class StellarWallet {
  private secretKey?: string;
  private pubKey?: string;
  private sdk: any;

  constructor(config: StellarWalletConfig) {
    this.secretKey = config.secretKey;
    this.pubKey = config.publicKey;
  }

  private async getSdk() {
    if (this.sdk) return this.sdk;
    try {
      this.sdk = await import('@stellar/stellar-sdk');
      return this.sdk;
    } catch {
      throw new NPaymentError(
        '@stellar/stellar-sdk is required for Stellar operations',
        'STELLAR_SDK_MISSING',
        'Install: npm install @stellar/stellar-sdk',
      );
    }
  }

  async getPublicKey(): Promise<string> {
    if (this.pubKey) return this.pubKey;
    const sdk = await this.getSdk();
    const keypair = sdk.Keypair.fromSecret(this.secretKey!);
    this.pubKey = keypair.publicKey();
    return this.pubKey!;
  }

  /** Sign a Stellar transaction XDR (base64) and return signed XDR */
  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    if (!this.secretKey) throw new NPaymentError('Secret key required for signing', 'STELLAR_NO_SECRET');
    const sdk = await this.getSdk();
    const keypair = sdk.Keypair.fromSecret(this.secretKey);
    const tx = sdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(keypair);
    return tx.toXDR();
  }

  /** Sign a Soroban auth entry for x402 payments */
  async signAuthEntry(entry: string): Promise<string> {
    if (!this.secretKey) throw new NPaymentError('Secret key required for signing', 'STELLAR_NO_SECRET');
    const sdk = await this.getSdk();
    const keypair = sdk.Keypair.fromSecret(this.secretKey);
    const signed = keypair.sign(Buffer.from(entry, 'base64'));
    return signed.toString('base64');
  }

  hasSecret(): boolean {
    return !!this.secretKey;
  }
}
