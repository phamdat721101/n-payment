import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, TypedData, TypedDataDomain } from 'viem';
import { ViemTransactor } from '../transactor.js';
import type { ChainConfig } from '../types.js';
import { CHAINS } from '../chains.js';
import type { OWSConfig, OWSSignResult } from './types.js';
import { NPaymentError } from '../errors.js';
import { createOWSDriver, type OWSDriver } from './cli-driver.js';

export interface TransactionRequest {
  to: string;
  value?: string;
  data?: string;
}

export class OWSWallet {
  private walletName: string;
  private privateKey?: Hex;
  private autoFaucet?: boolean;
  private transactors = new Map<number, ViemTransactor>();
  private driver: OWSDriver | null = null;
  private driverReady: Promise<void>;

  constructor(config: OWSConfig) {
    this.walletName = config.wallet;
    this.privateKey = config.privateKey as Hex | undefined;
    this.autoFaucet = config.autoFaucet;
    this.driverReady = createOWSDriver(config.cliPath).then(d => { this.driver = d; });
  }

  private async ensureReady(): Promise<void> {
    await this.driverReady;
  }

  private get useOWS(): boolean {
    return this.driver !== null;
  }

  private getTransactor(chainId: number): ViemTransactor {
    if (!this.privateKey) throw new NPaymentError('No privateKey and OWS SDK not available', 'NO_SIGNER', 'Install @open-wallet-standard/core or provide ows.privateKey');
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
    if (this.driver) return ''; // sync fallback, use async version
    return this.getTransactor(chainId).getAddress();
  }

  async getAddressAsync(chainId: number): Promise<string> {
    await this.ensureReady();
    if (this.driver) return this.driver.getAddress(this.walletName, chainId);
    return this.getTransactor(chainId).getAddress();
  }

  async getBalance(token: string, chainId: number): Promise<bigint> {
    await this.ensureReady();
    if (this.driver) return this.driver.getBalance(this.walletName, chainId, token);
    return this.getTransactor(chainId).getTokenBalance(this.getAddress(chainId), token);
  }

  async signTransaction(tx: TransactionRequest, chainId: number): Promise<OWSSignResult> {
    await this.ensureReady();
    if (this.driver) {
      const txHash = await this.driver.signTransaction(this.walletName, chainId, tx);
      return { txHash, blockNumber: 0n };
    }
    const result = await this.getTransactor(chainId).sendTransaction({ to: tx.to, value: tx.value ? BigInt(tx.value) : undefined, data: tx.data });
    return { txHash: result.txHash, blockNumber: result.blockNumber };
  }

  async transferERC20(to: string, token: string, amount: bigint, chainId: number): Promise<OWSSignResult> {
    await this.ensureReady();
    if (this.driver) {
      const txHash = await this.driver.transferERC20(this.walletName, chainId, to, token, amount);
      return { txHash, blockNumber: 0n };
    }
    const result = await this.getTransactor(chainId).transferERC20(to, token, amount);
    return { txHash: result.txHash, blockNumber: result.blockNumber };
  }

  async signMessage(message: string): Promise<string> {
    await this.ensureReady();
    if (this.driver) return this.driver.signMessage(this.walletName, message);
    if (!this.privateKey) throw new NPaymentError('No privateKey and OWS SDK not available', 'NO_SIGNER');
    const account = privateKeyToAccount(this.privateKey);
    return account.signMessage({ message });
  }

  /**
   * Sign EIP-712 typed data. Used for sponsored payment schemes (EIP-3009 transferWithAuthorization).
   * Local-key path is fully supported; OWS-driver path requires native EIP-712 in the driver
   * (tracked separately) — for now, callers using sponsored mode must supply ows.privateKey.
   */
  async signTypedData<T extends TypedData>(params: {
    domain: TypedDataDomain;
    types: T;
    primaryType: keyof T extends string ? keyof T : never;
    message: Record<string, unknown>;
  }): Promise<Hex> {
    await this.ensureReady();
    if (!this.privateKey) {
      throw new NPaymentError(
        'signTypedData requires ows.privateKey (OWS driver EIP-712 path not yet wired)',
        'NO_TYPED_DATA_SIGNER',
        'Pass ows: { privateKey: "0x..." } when using EIP-3009 sponsored payments on Hoodi.',
      );
    }
    const account = privateKeyToAccount(this.privateKey);
    return account.signTypedData({
      domain: params.domain,
      types: params.types,
      primaryType: params.primaryType as string,
      message: params.message,
    } as Parameters<typeof account.signTypedData>[0]);
  }

  async payX402(_url: string, _method?: string): Promise<string> {
    throw new NPaymentError('payX402 requires direct adapter usage', 'NOT_IMPLEMENTED');
  }

  /** Returns a viem LocalAccount if privateKey is available, null otherwise. */
  getAccount(): ReturnType<typeof privateKeyToAccount> | null {
    if (!this.privateKey) return null;
    return privateKeyToAccount(this.privateKey);
  }

  get walletName_(): string { return this.walletName; }
}
