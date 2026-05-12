import { CHAINS } from '../chains.js';
import type { ChainKey } from '../types.js';

export class XrplConnection {
  private client: any = null;
  private serverUrl: string;

  constructor(serverOrChain?: string | ChainKey) {
    if (serverOrChain && CHAINS[serverOrChain as ChainKey]) {
      this.serverUrl = CHAINS[serverOrChain as ChainKey].wsUrl ?? CHAINS[serverOrChain as ChainKey].rpcUrl;
    } else {
      this.serverUrl = serverOrChain ?? 'wss://s.altnet.rippletest.net:51233';
    }
  }

  async connect(): Promise<any> {
    if (this.client?.isConnected()) return this.client;
    const { Client } = await import('xrpl');
    this.client = new Client(this.serverUrl);
    await this.client.connect();
    return this.client;
  }

  async getClient(): Promise<any> {
    if (!this.client?.isConnected()) await this.connect();
    return this.client;
  }

  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  async disconnect(): Promise<void> {
    if (this.client?.isConnected()) {
      await this.client.disconnect();
    }
    this.client = null;
  }
}
