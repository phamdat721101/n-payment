/**
 * OWS CLI Driver — wraps `@open-wallet-standard/core` Node SDK.
 *
 * v0.27 — extended from EVM-only to all 11 OWS chain families via single
 * dispatch on `ChainFamily`. Returns `null` from `createOWSDriver()` when the
 * peer dep isn't installed; caller falls back to legacy `privateKey` mode.
 *
 * SOLID: Single Responsibility — adapts the OWS SDK to a stable internal
 * interface. CAIP-2 parsing happens in `caip2.ts`; payload construction
 * is family-specific and contained in this file's `dispatchSign` switch.
 */

import { CHAINS } from '../chains.js';
import type { ChainConfig } from '../types.js';
import { resolveFamily, resolveSpec, parseCaip2 } from './caip2.js';
import { owsError } from '../errors.js';
import type { ChainFamily, SignedTx } from './types.js';

/**
 * Internal driver interface. v0.27 keeps the EVM-only legacy methods
 * (used by `OWSWallet` legacy path) AND adds CAIP-2-keyed methods
 * (used by the new multichain path).
 */
export interface OWSDriver {
  // ─── Legacy EVM methods (v0.25, kept for back-compat) ───────────────────
  getAddress(walletName: string, chainId: number): Promise<string>;
  signTransaction(walletName: string, chainId: number, tx: { to: string; value?: string; data?: string }): Promise<string>;
  signMessage(walletName: string, message: string): Promise<string>;
  getBalance(walletName: string, chainId: number, token: string): Promise<bigint>;
  transferERC20(walletName: string, chainId: number, to: string, token: string, amount: bigint): Promise<string>;

  // ─── v0.27 multichain methods ───────────────────────────────────────────
  getAddressForCaip2(walletName: string, caip2: string): Promise<string>;
  signMessageForCaip2(walletName: string, caip2: string, message: string): Promise<string>;
  signAndSendForCaip2(walletName: string, caip2: string, txPayload: unknown): Promise<SignedTx>;
}

function getChainConfig(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find((c) => c.chainId === chainId);
}

/** Pull an account from a Wallet object by CAIP-2 (with family fallback). */
function pickAccount(wallet: { accounts: { address: string; chainId: string }[] }, caip2: string): string | undefined {
  const exact = wallet.accounts.find((a) => a.chainId === caip2);
  if (exact) return exact.address;
  const { namespace } = parseCaip2(caip2);
  const familyMatch = wallet.accounts.find((a) => a.chainId.startsWith(`${namespace}:`));
  return familyMatch?.address;
}

/**
 * Family-keyed payload-encoder for `signAndSend`. The OWS SDK is permissive —
 * it accepts a JSON string for every family and parses inside the Rust core.
 * v0.27 sends the payload as JSON.stringify(txPayload); each family adapter
 * (xrpl/solana/cosmos/etc.) decides the wire shape upstream of this driver.
 */
function encodePayload(txPayload: unknown): string {
  if (typeof txPayload === 'string') return txPayload;
  return JSON.stringify(txPayload);
}

let cachedDriver: OWSDriver | null | undefined;

export async function createOWSDriver(_cliPath?: string): Promise<OWSDriver | null> {
  if (cachedDriver !== undefined) return cachedDriver;
  try {
    const ows = await import('@open-wallet-standard/core');

    cachedDriver = {
      // ─── Legacy EVM methods ──────────────────────────────────────────────
      async getAddress(walletName, chainId) {
        const wallet = ows.getWallet(walletName);
        const account = wallet.accounts.find((a: { chainId: string }) => a.chainId === `eip155:${chainId}`);
        return account?.address ?? wallet.accounts[0]?.address ?? '';
      },

      async signTransaction(walletName, chainId, tx) {
        const chainConfig = getChainConfig(chainId);
        if (!chainConfig) throw new Error(`Chain ${chainId} not found`);
        const { createPublicClient, http, defineChain, serializeTransaction } = await import('viem');
        const viemChain = defineChain({
          id: chainId,
          name: chainConfig.name,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
        });
        const client = createPublicClient({ chain: viemChain, transport: http(chainConfig.rpcUrl) });
        const address = (await this.getAddress(walletName, chainId)) as `0x${string}`;
        const nonce = await client.getTransactionCount({ address });
        const block = await client.getBlock();
        const baseFee = block.baseFeePerGas ?? 1_000_000_000n;
        const rawTx = {
          to: tx.to as `0x${string}`,
          value: tx.value ? BigInt(tx.value) : 0n,
          data: (tx.data ?? '0x') as `0x${string}`,
          nonce,
          gas: 100_000n,
          maxFeePerGas: baseFee * 2n,
          maxPriorityFeePerGas: 1_000_000n,
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
        const viemChain = defineChain({
          id: chainId,
          name: chainConfig.name,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [chainConfig.rpcUrl] } },
        });
        const client = createPublicClient({ chain: viemChain, transport: http(chainConfig.rpcUrl) });
        const wallet = ows.getWallet(walletName);
        const account = wallet.accounts.find((a: { chainId: string }) => a.chainId === `eip155:${chainId}`);
        const address = account?.address ?? wallet.accounts[0]?.address;
        if (!address) return 0n;
        try {
          const balance = await client.readContract({
            address: token as `0x${string}`,
            abi: [
              {
                name: 'balanceOf',
                type: 'function',
                stateMutability: 'view',
                inputs: [{ name: 'owner', type: 'address' }],
                outputs: [{ name: '', type: 'uint256' }],
              },
            ] as const,
            functionName: 'balanceOf',
            args: [address as `0x${string}`],
          });
          return balance as bigint;
        } catch {
          return 0n;
        }
      },

      async transferERC20(walletName, chainId, to, token, amount) {
        const data = '0xa9059cbb' + to.slice(2).padStart(64, '0') + amount.toString(16).padStart(64, '0');
        return this.signTransaction(walletName, chainId, { to: token, data });
      },

      // ─── v0.27 multichain methods (single dispatch on family) ───────────
      async getAddressForCaip2(walletName, caip2) {
        const family = resolveFamily(caip2);
        const wallet = ows.getWallet(walletName);
        const address = pickAccount(wallet, caip2);
        if (!address) {
          throw owsError(
            'OWS_WALLET_NOT_FOUND',
            `wallet "${walletName}" has no account for ${caip2} (family: ${family})`,
          );
        }
        return address;
      },

      async signMessageForCaip2(walletName, caip2, message) {
        const family = resolveFamily(caip2);
        try {
          const result = await ows.signMessage(walletName, family, message);
          return result.signature;
        } catch (err) {
          throw owsError(
            'OWS_FAMILY_PARTIAL',
            `signMessage(${family}) rejected by SDK: ${(err as Error).message}`,
          );
        }
      },

      async signAndSendForCaip2(walletName, caip2, txPayload) {
        const family = resolveFamily(caip2);
        const spec = resolveSpec(caip2);
        const payload = encodePayload(txPayload);
        // EVM keeps the rich legacy encoding (nonce + viem). Other families pass
        // payload through to the SDK; chain-specific adapters upstream supply
        // the correct shape per family.
        try {
          const result = await ows.signAndSend(walletName, caip2, payload, null, null, null);
          return { txHash: result.txHash, family: spec.family };
        } catch (err) {
          throw owsError(
            'OWS_FAMILY_PARTIAL',
            `signAndSend(${family}) rejected by SDK: ${(err as Error).message}`,
          );
        }
      },
    };

    return cachedDriver;
  } catch {
    cachedDriver = null;
    return null;
  }
}

/** Return all OWS chain families the cached driver currently has accounts for. */
export async function listAvailableFamilies(walletName: string): Promise<ChainFamily[]> {
  const driver = await createOWSDriver();
  if (!driver) return [];
  try {
    const ows = await import('@open-wallet-standard/core');
    const wallet = ows.getWallet(walletName);
    const families = new Set<ChainFamily>();
    for (const account of wallet.accounts) {
      try {
        families.add(resolveFamily(account.chainId));
      } catch {
        /* ignore unknown namespaces */
      }
    }
    return [...families];
  } catch {
    return [];
  }
}
