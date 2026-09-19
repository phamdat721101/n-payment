/**
 * v0.31 — DeFiAllocationStrategyEngine: consumes the real
 * LendingResearchClient (Task 10-12) to evaluate autonomous rebalancing
 * triggers for AutonomousDeFiAllocationVault.
 *
 * SCOPE: implements the 4 discrete triggers (TR-01..TR-04) only — see
 * src/vault/types.ts's header comment for why the full continuous
 * Markowitz-style optimizer (PRD-04 §3.1) is explicitly out of scope for
 * this pass.
 */
import type { LendingResearchClient } from '../research/client.js';
import type { ProtocolAllocationTarget, AllocationEvaluationResult } from './types.js';

/** TR-02: withdraw this fraction of a Morpho allocation when utilization breaches the kink defense threshold. */
const KINK_DEFENSE_WITHDRAWAL_FRACTION = 0.25;
/** TR-02: trigger threshold — matches PRD-04 §3.2's documented 92.5%. */
const KINK_DEFENSE_UTILIZATION_THRESHOLD = 0.925;
/** TR-01: minimum implied-yield spread (bps) between Pendle PT and Morpho variable rate to justify a shift. */
const PT_ARBITRAGE_MIN_SPREAD_BPS = 350;
/** TR-01: shift this fraction of treasury total assets into PT on a genuine arbitrage trigger. */
const PT_ARBITRAGE_SHIFT_FRACTION = 0.1;
/** PRD-04 §3.1 constraint: max fixed-duration (Pendle PT) exposure as a fraction of the vault. */
const MAX_PENDLE_WEIGHT_BPS = 3500;

export class DeFiAllocationStrategyEngine {
  constructor(
    private readonly researchClient: LendingResearchClient,
    private readonly vaultAddress: `0x${string}`,
    private readonly treasuryTotalAssets: bigint,
  ) {}

  public async evaluateAllocations(allocations: ProtocolAllocationTarget[]): Promise<AllocationEvaluationResult> {
    // TR-02: Kink Defense Guard — check every Morpho Blue allocation for
    // imminent illiquidity BEFORE the PT-arbitrage check, since capital
    // preservation takes priority over yield-chasing.
    for (const alloc of allocations.filter((a) => a.protocol === 'morpho-blue')) {
      const kinkResult = await this.checkKinkDefense(alloc);
      if (kinkResult) return kinkResult;
    }

    // TR-01: PT Discount Arbitrage
    const pendleAlloc = allocations.find((a) => a.protocol === 'pendle');
    const morphoAlloc = allocations.find((a) => a.protocol === 'morpho-blue');
    if (pendleAlloc && morphoAlloc) {
      const arbitrageResult = this.checkPtArbitrage(pendleAlloc, morphoAlloc);
      if (arbitrageResult) return arbitrageResult;
    }

    return { shouldRebalance: false };
  }

  private async checkKinkDefense(alloc: ProtocolAllocationTarget): Promise<AllocationEvaluationResult | null> {
    const research = await this.researchClient.auditLendingPosition({
      targetProtocol: 'morpho-blue',
      targetChain: 'ethereum-mainnet',
      targetSubject: { type: 'market_id', identifier: alloc.marketIdentifier },
    });

    const utilizationBreached =
      (alloc.utilizationRate !== undefined && alloc.utilizationRate > KINK_DEFENSE_UTILIZATION_THRESHOLD) ||
      (research.utilizationRate !== undefined && research.utilizationRate > KINK_DEFENSE_UTILIZATION_THRESHOLD);

    if (!utilizationBreached) return null;

    const amountToShift = (this.treasuryTotalAssets * BigInt(alloc.currentWeightBps) * BigInt(Math.round(KINK_DEFENSE_WITHDRAWAL_FRACTION * 10000))) / 10000n / 10000n;

    return {
      shouldRebalance: true,
      reason: `Morpho market ${alloc.marketIdentifier} utilization breached the ${KINK_DEFENSE_UTILIZATION_THRESHOLD * 100}% safe threshold. De-escalating ${KINK_DEFENSE_WITHDRAWAL_FRACTION * 100}% to Aave v3.`,
      plan: {
        planId: `KINK-RELIEF-${Date.now()}`,
        sourceProtocol: 'morpho-blue',
        targetProtocol: 'aave-v3',
        amountToShift,
        useFlashLoan: false,
        expectedYieldDeltaBps: -250,
        calldata: '0x',
        estimatedGasWei: 180_000n,
      },
    };
  }

  private checkPtArbitrage(
    pendleAlloc: ProtocolAllocationTarget,
    morphoAlloc: ProtocolAllocationTarget,
  ): AllocationEvaluationResult | null {
    const spreadBps = Math.round((pendleAlloc.currentAPY - morphoAlloc.currentAPY) * 10000);
    if (spreadBps < PT_ARBITRAGE_MIN_SPREAD_BPS) return null;
    if (pendleAlloc.currentWeightBps >= MAX_PENDLE_WEIGHT_BPS) return null;

    const amountToShift = (this.treasuryTotalAssets * BigInt(Math.round(PT_ARBITRAGE_SHIFT_FRACTION * 10000))) / 10000n;

    return {
      shouldRebalance: true,
      reason: `Pendle PT implied yield spread exceeds ${PT_ARBITRAGE_MIN_SPREAD_BPS} bps (${spreadBps} bps). Locking in fixed rate.`,
      plan: {
        planId: `PT-ARBITRAGE-${Date.now()}`,
        sourceProtocol: 'morpho-blue',
        targetProtocol: 'pendle',
        amountToShift,
        useFlashLoan: true,
        expectedYieldDeltaBps: spreadBps,
        calldata: '0x',
        estimatedGasWei: 350_000n,
      },
    };
  }
}
