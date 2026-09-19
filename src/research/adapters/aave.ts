/**
 * v0.31 — Aave v3 protocol adapter for OnchainLendingResearchService.
 *
 * Builds on (does not replace) the existing src/aave/client.ts's
 * AaveClient / AAVE_POOL_ADDRESSES — that map's addresses were already
 * verified correct during planning (0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
 * on Ethereum matches aave-dao/aave-address-book and aave.com's own docs).
 *
 * NOTE on chain-key naming: AAVE_POOL_ADDRESSES uses ad-hoc short keys
 * ('ethereum', 'arbitrum') that predate this SDK's full ChainKey union and
 * do NOT match the research module's ResearchChainKey values
 * ('ethereum-mainnet', 'arbitrum-one'). This adapter maps between the two
 * rather than renaming the existing map (out of scope / would risk
 * breaking other AaveClient consumers).
 */
import type { PublicClient } from 'viem';
import type { ProtocolAdapter, SubjectContext, PositionHealthSnapshot } from './interface.js';
import type { ResearchChainKey } from '../types.js';
import type { OnchainTxGraphNode } from '../types.js';
import { AAVE_POOL_ADDRESSES } from '../../aave/client.js';
import { LiveRpcCallFailedError } from '../errors.js';

/** Maps ResearchChainKey -> the legacy short key used by AAVE_POOL_ADDRESSES. */
const RESEARCH_TO_AAVE_CLIENT_KEY: Partial<Record<ResearchChainKey, string>> = {
  'ethereum-mainnet': 'ethereum',
  'base-mainnet': 'base-mainnet',
  'arbitrum-one': 'arbitrum',
  // optimism-mainnet intentionally omitted: not present in AAVE_POOL_ADDRESSES today.
};

const AAVE_POOL_ABI = [
  {
    type: 'function',
    name: 'getUserAccountData',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' },
    ],
  },
] as const;

/** Aave's real "no debt" sentinel returned by getUserAccountData(): type(uint256).max. */
const NO_DEBT_HEALTH_FACTOR_SENTINEL = 2n ** 256n - 1n;

export class AaveV3Adapter implements ProtocolAdapter {
  public readonly protocol = 'aave-v3' as const;
  public readonly supportedChains: ResearchChainKey[] = ['ethereum-mainnet', 'base-mainnet', 'arbitrum-one'];

  constructor(private readonly client: PublicClient, private readonly chain: ResearchChainKey) {}

  private getPoolAddress(): `0x${string}` {
    const legacyKey = RESEARCH_TO_AAVE_CLIENT_KEY[this.chain];
    const address = legacyKey ? AAVE_POOL_ADDRESSES[legacyKey] : undefined;
    if (!address) {
      throw new LiveRpcCallFailedError('aave-v3', `No Aave v3 Pool address configured for chain "${this.chain}"`);
    }
    return address;
  }

  public async fetchPositionContext(subject: SubjectContext): Promise<PositionHealthSnapshot> {
    try {
      const poolAddress = this.getPoolAddress();
      const result = (await this.client.readContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'getUserAccountData',
        args: [subject.identifier as `0x${string}`],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

      const [totalCollateralBase, totalDebtBase, , currentLiquidationThreshold, ltv, healthFactorRaw] = result;

      // Base currency units are 8-decimal (Aave's price-feed base currency,
      // typically USD) per aave.com's own docs.
      const totalCollateralUsd = Number(totalCollateralBase) / 1e8;
      const totalDebtUsd = Number(totalDebtBase) / 1e8;
      const liquidationThresholdLtv = Number(currentLiquidationThreshold) / 10000; // bps -> ratio
      const currentLtv = totalCollateralUsd > 0 ? totalDebtUsd / totalCollateralUsd : 0;
      const healthFactor = healthFactorRaw >= NO_DEBT_HEALTH_FACTOR_SENTINEL ? Infinity : Number(healthFactorRaw) / 1e18;

      return {
        protocol: this.protocol,
        chain: this.chain,
        subjectIdentifier: subject.identifier,
        totalCollateralUsd,
        totalDebtUsd,
        currentLtv,
        liquidationThresholdLtv,
        healthFactor,
        // Real supply/borrow APY requires per-reserve getReserveData() +
        // ray-scaled rate conversion — out of scope for this pass (mirrors
        // the Morpho adapter's same documented scope-narrowing).
        borrowApy: 0,
        supplyApy: 0,
      };
    } catch (err) {
      if (err instanceof LiveRpcCallFailedError) throw err;
      throw new LiveRpcCallFailedError('aave-v3', err instanceof Error ? err.message : String(err));
    }
  }

  public async fetchRecentLiquidationEvents(_subject: SubjectContext, _lookbackBlocks: number): Promise<OnchainTxGraphNode[]> {
    // Aave v3's LiquidationCall event decoding is deferred to a future pass
    // (this adapter's Task 6 scope is the position-health read path only,
    // matching the plan's "build on existing AaveClient" framing). Returns
    // an empty, well-formed array rather than fabricating liquidation data.
    return [];
  }
}
