/**
 * v0.31 — Pendle protocol adapter for OnchainLendingResearchService.
 *
 * CORRECTED DESIGN (deviates intentionally from the original PRD-02 sketch):
 * the PRD called `PendleRouter` (`0x00000000005BBB0EF59571E58418F9a4357b68A0`)
 * for a read-only research query. Two problems, both fixed here:
 *   1. That address does not match any real Pendle deployment (verified
 *      against pendle-finance/pendle-core-v2-public's deployments/1-core.json
 *      — the real Router is 0x888888888889758F76e7103c6CbF23ABbF58F946).
 *   2. Even the real Router is the WRONG contract for a research/read
 *      adapter — Pendle's own docs (docs.pendle.finance/.../Oracle/PYLpOracle)
 *      direct integrators to `PendlePYLpOracle` (TWAP price oracle) for
 *      reading PT/YT/LP price and implied-yield state; the Router is
 *      reserved for swap/mint/redeem execution.
 *
 * This adapter therefore reads via `PendlePYLpOracle.getPtToSyRate()`,
 * after checking `getOracleState()` confirms the market's TWAP ring buffer
 * has sufficient cardinality — reading `duration=0` (spot rate) in
 * production is explicitly discouraged by Pendle's own docs because spot
 * rates are manipulable within a single block (mirrors PRD-06's Tiger T2
 * concern about flash-loan price manipulation, here addressed at the
 * oracle-selection level rather than after the fact).
 */
import type { PublicClient } from 'viem';
import type { ProtocolAdapter, SubjectContext, PositionHealthSnapshot } from './interface.js';
import type { ResearchChainKey } from '../types.js';
import type { OnchainTxGraphNode } from '../types.js';
import { LiveRpcCallFailedError } from '../errors.js';
import { calculateMacaulayDuration } from '../risk/invariants.js';

/** Real Pendle Router (IPAllActionV3), verified via deployments/1-core.json. Swap/mint/redeem execution only — NOT used for reads by this adapter. */
export const PENDLE_ROUTER_ADDRESS = '0x888888888889758F76e7103c6CbF23ABbF58F946' as const;

/** Real PendlePYLpOracle address (Ethereum mainnet), verified via deployments/1-core.json's `pyYtLpOracle` key. */
export const PENDLE_PY_LP_ORACLE_ADDRESS = '0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2' as const;

/** Default TWAP window (seconds) used for oracle reads — 15 minutes, matching Pendle's own documented example cardinality table. */
const DEFAULT_TWAP_DURATION_SECONDS = 900;

const PENDLE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getOracleState',
    stateMutability: 'view',
    inputs: [
      { name: 'market', type: 'address' },
      { name: 'duration', type: 'uint32' },
    ],
    outputs: [
      { name: 'increaseCardinalityRequired', type: 'bool' },
      { name: 'cardinalityRequired', type: 'uint16' },
      { name: 'oldestObservationSatisfied', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getPtToSyRate',
    stateMutability: 'view',
    inputs: [
      { name: 'market', type: 'address' },
      { name: 'duration', type: 'uint32' },
    ],
    outputs: [{ name: 'rate', type: 'uint256' }],
  },
] as const;

/** Minimal PendleMarket ABI slice — `expiry()` is a real, documented on-chain field (docs.pendle.finance/.../PendleMarket). */
const PENDLE_MARKET_ABI = [
  {
    type: 'function',
    name: 'expiry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export class PendleAdapter implements ProtocolAdapter {
  public readonly protocol = 'pendle' as const;
  public readonly supportedChains: ResearchChainKey[] = ['ethereum-mainnet', 'arbitrum-one'];

  constructor(private readonly client: PublicClient, private readonly chain: ResearchChainKey) {}

  public async fetchPositionContext(subject: SubjectContext): Promise<PositionHealthSnapshot> {
    const marketAddress = subject.identifier as `0x${string}`;

    try {
      const expiryTimestamp = (await this.client.readContract({
        address: marketAddress,
        abi: PENDLE_MARKET_ABI,
        functionName: 'expiry',
        args: [],
      })) as bigint;

      const daysToMaturity = (Number(expiryTimestamp) - Math.floor(Date.now() / 1000)) / 86400;

      const [increaseCardinalityRequired, , oldestObservationSatisfied] = (await this.client.readContract({
        address: PENDLE_PY_LP_ORACLE_ADDRESS,
        abi: PENDLE_ORACLE_ABI,
        functionName: 'getOracleState',
        args: [marketAddress, DEFAULT_TWAP_DURATION_SECONDS],
      })) as readonly [boolean, number, boolean];

      if (increaseCardinalityRequired || !oldestObservationSatisfied) {
        throw new Error(
          `Pendle market ${marketAddress}'s oracle TWAP ring buffer is not yet initialized/warmed for a ${DEFAULT_TWAP_DURATION_SECONDS}s window ` +
            `(increaseCardinalityRequired=${increaseCardinalityRequired}, oldestObservationSatisfied=${oldestObservationSatisfied}). ` +
            'Refusing to fall back to a manipulable duration=0 spot read.',
        );
      }

      const ptToSyRateRaw = (await this.client.readContract({
        address: PENDLE_PY_LP_ORACLE_ADDRESS,
        abi: PENDLE_ORACLE_ABI,
        functionName: 'getPtToSyRate',
        args: [marketAddress, DEFAULT_TWAP_DURATION_SECONDS],
      })) as bigint;

      const ptPrice = Number(ptToSyRateRaw) / 1e18; // e.g. 0.912 SY per PT
      const timeToMaturityYears = daysToMaturity / 365;
      const impliedApy = timeToMaturityYears > 0 && ptPrice > 0 ? Math.pow(1 / ptPrice, 1 / timeToMaturityYears) - 1 : 0;
      const duration = calculateMacaulayDuration(daysToMaturity, impliedApy);

      return {
        protocol: this.protocol,
        chain: this.chain,
        subjectIdentifier: subject.identifier,
        // An unleveraged PT position has no debt: currentLtv=0, health
        // factor is Infinity (never liquidatable), matching PRD-02's own
        // correct observation about unleveraged PT holders.
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        currentLtv: 0,
        liquidationThresholdLtv: 1.0,
        healthFactor: Infinity,
        borrowApy: 0,
        supplyApy: impliedApy,
        macaulayDurationDays: duration.modifiedDuration !== null ? duration.modifiedDuration * 365 : undefined,
      };
    } catch (err) {
      throw new LiveRpcCallFailedError('pendle', err instanceof Error ? err.message : String(err));
    }
  }

  public async fetchRecentLiquidationEvents(_subject: SubjectContext, _lookbackBlocks: number): Promise<OnchainTxGraphNode[]> {
    // An unleveraged Pendle PT position cannot be liquidated (matches
    // PRD-02's own correct framing) — this adapter intentionally returns []
    // rather than fabricating liquidation-shaped events. Leveraged PT
    // looping positions (e.g. via Morpho/Euler using PT as collateral) are
    // audited through THOSE protocols' adapters, not this one.
    return [];
  }
}
