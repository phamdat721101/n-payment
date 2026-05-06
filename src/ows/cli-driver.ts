/**
 * OWS CLI Driver - wraps @open-wallet-standard/core Node.js SDK.
 * Returns null from create() if the package is not installed.
 */

import { CHAINS } from '../chains.js';
import type { ChainConfig } from '../types.js';

export interface OWSDriver {
  getAddress(walletName: string, chainId: number): Promise<string>;
  signTransaction(walletName: string, chainId: number, tx: { to: string; value?: string; data?: string }): Promise<string>;
  signMessage(walletName: string, message: string): Promise<string>;
  getBalance(walletName: string, chainId: number, token: string): Promise<bigint>;
  transferERC20(walletName: string, chainId: number, to: string, token: string, amount: bigint): Promise<string>;
}

function getChainConfig(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}

let cachedDriver: OWSDriver | null | undefined;

export async function createOWSDriver(cliPath?: string): Promise<OWSDriver | null> {
  if (cachedDriver !== undefined) return cachedDriver;
  try {
    const ows = await import('@open-wallet-standard/core');
    cachedDriver = {
      async getAddress(walletName, chainId) {
        const wallet = ows.getWallet(walletName);
        const account = wallet.accounts.find((a: any) => a.chainId === `eip155:${chainId}`);
        return account?.address ?? wallet.accounts[0]?.address ?? '';
      },

      async signTransaction(walletName, chainId, tx) {
        const chainConfig = getChainConfig(chainId);
        if (!chainConfig) throw new Error(`Chain ${chainId} not found`);
        const { createPublicClient, http, defineChain, serializeTransaction } = await import('viem');
        const viemChain = defineChain({ id: chainId, name: chainConfig.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chainConfig.rpcUrl] } } });
        const client = createPublicClient({ chain: viemChain, transport: http(chainConfig.rpcUrl) });
        const address = (await this.getAddress(walletName, chainId)) as `0x${string}`;
        const nonce = await client.getTransactionCount({ address });
        const block = await client.getBlock();
        const baseFee = block.baseFeePerGas ?? 1000000000n;
        const rawTx = {
          to: tx.to as `0x${string}`,
          value: tx.value ? BigInt(tx.value) : 0n,
          data: (tx.data ?? '0x') as `0x${string}`,
          nonce,
          gas: 100000n,
          maxFeePerGas: baseFee * 2n,
          maxPriorityFeePerGas: 1000000n,
          chainId,
          type: 'eip1559' as const,
        };
        const serialized = serializeTransaction(rawTx);
        const result = await ows.signAndSend(walletName, `eip155:${chainId}`, serialized, null, null, chainConfig.rpcUrl);
        return result.txHash;
      },

      async signMessage(walletName, message) {
        const result = await ows.signMessage(walletName, 'evm', message);
        return result.signature;
      },

      async getBalance(walletName, chainId, token) {
        const { createPublicClient, http, defineChain } = await import('viem');
        const chainConfig = getChainConfig(chainId);
        if (!chainConfig) return 0n;
        const viemChain = defineChain({ id: chainId, name: chainConfig.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [chainConfig.rpcUrl] } } });
        const client = createPublicClient({ chain: viemChain, transport: http(chainConfig.rpcUrl) });
        const wallet = ows.getWallet(walletName);
        const account = wallet.accounts.find((a: any) => a.chainId === `eip155:${chainId}`);
        const address = account?.address ?? wallet.accounts[0]?.address;
        if (!address) return 0n;
        try {
          const balance = await client.readContract({
            address: token as `0x${string}`,
            abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const,
            functionName: 'balanceOf',
            args: [address as `0x${string}`],
          });
          return balance as bigint;
        } catch { return 0n; }
      },

      async transferERC20(walletName, chainId, to, token, amount) {
        const data = '0xa9059cbb' + to.slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');
        return this.signTransaction(walletName, chainId, { to: token, data });
      },
    };
    return cachedDriver;
  } catch {
    cachedDriver = null;
    return null;
  }
}
