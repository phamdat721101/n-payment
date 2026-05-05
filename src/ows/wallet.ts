import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { ViemTransactor } from '../transactor.js';
import type { ChainConfig } from '../types.js';
import { CHAINS } from '../chains.js';
import type { OWSConfig, OWSSignResult } from './types.js';
import { NPaymentError } from '../errors.js';

export interface TransactionRequest {
  to: string;
  value?: string;
  data?: string;
}

export class OWSWallet {
  private wallet: string;
  private privateKey: Hex;
  private autoFaucet?: boolean;
  private transactors = new Map<number, ViemTransactor>();

  constructor(config: OWSConfig) {
    this.wallet = config.wallet;
    this.privateKey = config.privateKey as Hex;
    this.autoFaucet = config.autoFaucet;
  }

  private getTransactor(chainId: number): ViemTransactor {
    let t = this.transactors.get(chainId);
    if (!t) {
      const chain = Object.values(CHAINS).find((c: ChainConfig) => c.chainId === chainId);
      if (!chain) throw new NPaymentError(`Chain ${chainId} not found`, 'CHAIN_NOT_FOUND');
      t = new ViemTransactor(chain, this.privateKey, this.autoFaucet);
      this.transactors.set(chainId, t);
    }
    return t;
  }

  getAddress(chainId: number): string {
    return this.getTransactor(chainId).getAddress();
  }

  async getBalance(token: string, chainId: number): Promise<bigint> {
    return this.getTransactor(chainId).getTokenBalance(this.getAddress(chainId), token);
  }

  async signTransaction(tx: TransactionRequest, chainId: number): Promise<OWSSignResult> {
    const result = await this.getTransactor(chainId).sendTransaction({ to: tx.to, value: tx.value ? BigInt(tx.value) : undefined, data: tx.data });
    return { txHash: result.txHash, blockNumber: result.blockNumber };
  }

  async transferERC20(to: string, token: string, amount: bigint, chainId: number): Promise<OWSSignResult> {
    const result = await this.getTransactor(chainId).transferERC20(to, token, amount);
    return { txHash: result.txHash, blockNumber: result.blockNumber };
  }

  async signMessage(message: string): Promise<string> {
    const account = privateKeyToAccount(this.privateKey);
    return account.signMessage({ message });
  }

  async payX402(_url: string, _method?: string): Promise<string> {
    throw new NPaymentError('payX402 requires direct adapter usage', 'NOT_IMPLEMENTED');
  }

  get walletName(): string { return this.wallet; }
}
