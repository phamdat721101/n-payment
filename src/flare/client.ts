import { createPublicClient, defineChain, http } from 'viem';
import type { Address, PublicClient } from 'viem';
import { NPaymentError } from '../errors.js';
import type { FlareConfig, FlareNetwork } from '../types.js';
import { flareContractRegistryAbi } from './abis.js';

// ─── Constants (single source of truth) ──────────────────────────────────────

/**
 * Canonical FlareContractRegistry root address. Identical across Flare mainnet,
 * Coston2, and Songbird. Source: https://dev.flare.network/network/guides/flare-contracts-registry
 */
export const FLARE_CONTRACT_REGISTRY_ADDRESS =
  '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019' as const;

/** Per-network public RPC defaults. v0.19: Coston2 testnet + Songbird + Flare mainnet. */
const RPC_URLS: Readonly<Record<FlareNetwork, string>> = Object.freeze({
  'coston2-testnet': 'https://coston2-api.flare.network/ext/C/rpc',
  'songbird-mainnet': 'https://songbird-api.flare.network/ext/C/rpc',
  'flare-mainnet': 'https://flare-api.flare.network/ext/C/rpc',
});

/** Per-network viem chain definitions (avoids depending on viem's per-version chain list). */
const CHAIN_DEFS: Readonly<Record<FlareNetwork, ReturnType<typeof defineChain>>> = Object.freeze({
  'coston2-testnet': defineChain({
    id: 114,
    name: 'Flare Coston2 Testnet',
    nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URLS['coston2-testnet']] } },
    testnet: true,
  }),
  'songbird-mainnet': defineChain({
    id: 19,
    name: 'Songbird',
    nativeCurrency: { name: 'Songbird', symbol: 'SGB', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URLS['songbird-mainnet']] } },
  }),
  'flare-mainnet': defineChain({
    id: 14,
    name: 'Flare',
    nativeCurrency: { name: 'Flare', symbol: 'FLR', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URLS['flare-mainnet']] } },
  }),
});

/** Contract names registered in the FlareContractRegistry — exact strings matter. */
export type FlareContractName =
  | 'AssetManagerFXRP'
  | 'MasterAccountController'
  | 'MintingTagManager';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const REGISTRY_TTL_MS = 5 * 60_000; // 5 minutes — addresses change only on protocol upgrades.

// ─── FlareContractsRegistry ──────────────────────────────────────────────────

/**
 * Cached resolver for Flare contract addresses. Reads from the well-known
 * FlareContractRegistry once per name per TTL window; subsequent lookups are
 * free. Throws FLARE_CONTRACT_NOT_FOUND on zero-address responses with an
 * actionable hint.
 */
export class FlareContractsRegistry {
  private readonly cache = new Map<string, { address: Address; expiresAt: number }>();

  constructor(
    private readonly publicClient: PublicClient,
    private readonly root: Address = FLARE_CONTRACT_REGISTRY_ADDRESS,
  ) {}

  async address(name: FlareContractName): Promise<Address> {
    const now = Date.now();
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > now) return hit.address;

    const result = (await this.publicClient.readContract({
      address: this.root,
      abi: flareContractRegistryAbi,
      functionName: 'getContractAddressByName',
      args: [name],
    })) as Address;

    if (!result || result.toLowerCase() === ZERO_ADDRESS) {
      throw new NPaymentError(
        `Flare contract "${name}" not registered`,
        'FLARE_CONTRACT_NOT_FOUND',
        `Verify the contract is deployed on this network and the name spelling matches the registry.`,
      );
    }

    this.cache.set(name, { address: result, expiresAt: now + REGISTRY_TTL_MS });
    return result;
  }

  /** Test/operational helper — drop the cache so the next read hits the chain. */
  clearCache(): void {
    this.cache.clear();
  }
}

// ─── FlareClient ─────────────────────────────────────────────────────────────

export interface FlareClientConfig extends FlareConfig {
  /** Inject a pre-built viem PublicClient. Useful for tests or shared transports. */
  publicClient?: PublicClient;
}

/**
 * Thin viem PublicClient wrapper bound to a Flare network with an attached
 * FlareContractsRegistry. Single source of read I/O for the rest of the
 * Flare module.
 */
export class FlareClient {
  readonly publicClient: PublicClient;
  readonly registry: FlareContractsRegistry;
  readonly network: FlareNetwork;

  constructor(config: FlareClientConfig = {}) {
    this.network = config.network ?? 'coston2-testnet';
    if (!CHAIN_DEFS[this.network]) {
      throw new NPaymentError(
        `Unsupported Flare network: ${this.network}`,
        'FLARE_UNSUPPORTED_NETWORK',
        `Use one of: ${Object.keys(CHAIN_DEFS).join(', ')}.`,
      );
    }

    this.publicClient =
      config.publicClient ??
      createPublicClient({
        chain: CHAIN_DEFS[this.network],
        transport: http(config.rpcUrl ?? RPC_URLS[this.network]),
      } as never);

    this.registry = new FlareContractsRegistry(
      this.publicClient,
      config.contractRegistry ?? FLARE_CONTRACT_REGISTRY_ADDRESS,
    );
  }
}

export function createFlareClient(config: FlareClientConfig = {}): FlareClient {
  return new FlareClient(config);
}
