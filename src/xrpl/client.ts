import { XrplWallet } from './wallet.js';
import { XrplConnection } from './connection.js';
import { XrplVaultClient } from './vault.js';
import { DiaOracleClient } from './oracle.js';
import { ensureTrustLine, sendRLUSD, getRLUSDBalance } from './payments.js';
import type { ChainKey, XrplConfig } from '../types.js';

export interface XrplClientConfig {
  seed?: string;
  owsWallet?: string;
  server?: string;
  network?: 'testnet' | 'mainnet';
}

export class XrplClient {
  readonly wallet: XrplWallet;
  readonly connection: XrplConnection;
  readonly vault: XrplVaultClient;
  readonly oracle: DiaOracleClient;

  constructor(config: XrplClientConfig) {
    const network = config.network ?? 'testnet';
    const chainKey: ChainKey = network === 'mainnet' ? 'xrpl-mainnet' : 'xrpl-testnet';

    this.wallet = new XrplWallet({ seed: config.seed, owsWallet: config.owsWallet });
    this.connection = new XrplConnection(config.server ?? chainKey);
    this.vault = new XrplVaultClient(this.connection, this.wallet);
    this.oracle = new DiaOracleClient(this.connection, network);
  }

  async getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  async ensureTrustLine(): Promise<string | null> {
    return ensureTrustLine(this.connection, this.wallet);
  }

  async sendRLUSD(destination: string, amount: string) {
    return sendRLUSD(this.connection, this.wallet, destination, amount);
  }

  async getBalance(address?: string): Promise<string> {
    const addr = address ?? await this.wallet.getAddress();
    return getRLUSDBalance(this.connection, addr);
  }

  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }
}

export function createXrplClient(config: XrplClientConfig): XrplClient {
  return new XrplClient(config);
}
