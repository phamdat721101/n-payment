import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig } from './types.js';
import { TestnetFaucet } from './faucet.js';

export type TransactionResult = { txHash: string; blockNumber: bigint };

const erc20Abi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

export class ViemTransactor {
  private publicClient;
  private walletClient;
  private account;
  private faucet?: TestnetFaucet;

  constructor(chainConfig: ChainConfig, privateKey: Hex, autoFaucet?: boolean) {
    const chain = defineChain({ id: chainConfig.chainId, name: `chain-${chainConfig.chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chainConfig.rpcUrl] } } });
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain, transport: http(chainConfig.rpcUrl) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(chainConfig.rpcUrl) });
    if (autoFaucet) this.faucet = new TestnetFaucet(chainConfig);
  }

  getAddress(): string {
    return this.account.address;
  }

  async getTokenBalance(owner: string, token: string): Promise<bigint> {
    return this.publicClient.readContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'balanceOf', args: [owner as `0x${string}`] });
  }

  async transferERC20(to: string, token: string, amount: bigint): Promise<TransactionResult> {
    await this.faucet?.ensureFunded(this.account.address, token);
    const txHash = await this.walletClient.writeContract({ address: token as `0x${string}`, abi: erc20Abi, functionName: 'transfer', args: [to as `0x${string}`, amount] });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: receipt.blockNumber };
  }

  async sendTransaction(tx: { to: string; value?: bigint; data?: string }): Promise<TransactionResult> {
    const txHash = await this.walletClient.sendTransaction({ to: tx.to as `0x${string}`, value: tx.value, data: tx.data as `0x${string}` | undefined });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: receipt.blockNumber };
  }
}
