/**
 * v0.31 — Silo v2 protocol adapter for OnchainLendingResearchService.
 *
 * Same factory-discovery pattern as EulerV2Adapter (Task 8): Silo v2 is a
 * permissionless, per-asset-pair vault factory (each "Silo" is an
 * ERC-4626-based two-asset isolated lending market), with per-CHAIN
 * factory addresses that differ from each other (unlike Morpho Blue's
 * single cross-chain singleton).
 *
 * REAL ADDRESSES — TWO LAYERS OF STALE-DATA CORRECTION DURING VERIFICATION:
 * (1) devdocs.silo.finance/security/smart-contracts's addresses were
 *     checked and found to be STALE v1 architecture (`SiloRepository`,
 *     `PriceProvidersRepository` terms) — not reused.
 * (2) DefiLlama's Silo V2 protocol PAGE quotes a `methodology` string
 *     citing 0xa42001d6...  (Ethereum) / 0xf7dc975C... (Arbitrum) — but a
 *     live `eth_getCode` call against 0xa42001d6... on Ethereum mainnet
 *     returned empty (`0x`, no contract at that address at all). Reading
 *     DefiLlama's ACTUAL adapter source
 *     (DefiLlama-Adapters/projects/silo-v2/index.js) revealed the quoted
 *     methodology STRING is itself stale prose that no longer matches the
 *     executable `configV2` object beside it — the real, currently-used
 *     factory addresses are the ones below, both independently confirmed
 *     to have real deployed bytecode via a live eth_getCode call during
 *     implementation.
 */
import type { PublicClient } from 'viem';
import type { ProtocolAdapter, SubjectContext, PositionHealthSnapshot } from './interface.js';
import type { ResearchChainKey } from '../types.js';
import type { OnchainTxGraphNode } from '../types.js';
import { LiveRpcCallFailedError } from '../errors.js';

/** Real, per-chain Silo v2 factory addresses — verified via DefiLlama's actual adapter source (configV2) + live eth_getCode. */
export const SILO_FACTORY_ADDRESSES: Partial<Record<ResearchChainKey, `0x${string}`>> = {
  'ethereum-mainnet': '0x22a3cF6149bFa611bAFc89Fd721918EC3Cf7b581',
  'arbitrum-one': '0x384DC7759d35313F0b567D42bf2f611B285B657C',
};

const SILO_FACTORY_ABI = [
  {
    type: 'function',
    name: 'isSilo',
    stateMutability: 'view',
    inputs: [{ name: 'silo', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/** ERC-4626-based Silo read surface (each Silo is an ERC-4626 vault; totalBorrows() is Silo-specific). */
const SILO_ABI = [
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBorrows',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export class SiloAdapter implements ProtocolAdapter {
  public readonly protocol = 'silo-v2' as const;
  public readonly supportedChains: ResearchChainKey[] = ['ethereum-mainnet', 'arbitrum-one'];

  constructor(private readonly client: PublicClient, private readonly chain: ResearchChainKey) {}

  public async fetchPositionContext(subject: SubjectContext): Promise<PositionHealthSnapshot> {
    if (subject.type !== 'vault_address') {
      throw new LiveRpcCallFailedError(
        'silo-v2',
        `Silo v2 requires a vault_address subject (got "${subject.type}") — there is no singleton market-id the way Morpho Blue has one.`,
      );
    }

    const factoryAddress = SILO_FACTORY_ADDRESSES[this.chain];
    if (!factoryAddress) {
      throw new LiveRpcCallFailedError('silo-v2', `No Silo v2 factory address configured for chain "${this.chain}"`);
    }

    const siloAddress = subject.identifier as `0x${string}`;

    try {
      const isSilo = (await this.client.readContract({
        address: factoryAddress,
        abi: SILO_FACTORY_ABI,
        functionName: 'isSilo',
        args: [siloAddress],
      })) as boolean;

      if (!isSilo) {
        throw new Error(`Address ${siloAddress} is not a known Silo per the real on-chain SiloFactory.isSilo() provenance check.`);
      }

      const [totalAssets, totalBorrows] = await Promise.all([
        this.client.readContract({ address: siloAddress, abi: SILO_ABI, functionName: 'totalAssets', args: [] }) as Promise<bigint>,
        this.client.readContract({ address: siloAddress, abi: SILO_ABI, functionName: 'totalBorrows', args: [] }) as Promise<bigint>,
      ]);

      const totalCollateralUsd = Number(totalAssets) / 1e6;
      const totalDebtUsd = Number(totalBorrows) / 1e6;
      const utilizationRate = Number(totalAssets) > 0 ? Number(totalBorrows) / Number(totalAssets) : 0;
      const currentLtv = totalCollateralUsd > 0 ? totalDebtUsd / totalCollateralUsd : 0;

      return {
        protocol: this.protocol,
        chain: this.chain,
        subjectIdentifier: subject.identifier,
        totalCollateralUsd,
        totalDebtUsd,
        currentLtv,
        // Real per-borrower LTV/liquidation-threshold requires reading the
        // paired Silo's configured LT via SiloConfig — out of scope for
        // this pass (same documented gap class as the Euler adapter).
        liquidationThresholdLtv: 0,
        healthFactor: Infinity,
        borrowApy: 0,
        supplyApy: 0,
        utilizationRate,
      };
    } catch (err) {
      if (err instanceof LiveRpcCallFailedError) throw err;
      throw new LiveRpcCallFailedError('silo-v2', err instanceof Error ? err.message : String(err));
    }
  }

  public async fetchRecentLiquidationEvents(_subject: SubjectContext, _lookbackBlocks: number): Promise<OnchainTxGraphNode[]> {
    // Liquidation event decoding for Silo v2 is deferred to a future pass
    // (matches the Aave/Morpho/Euler adapters' equivalent scope-narrowing).
    return [];
  }
}
