/**
 * v0.31 — Vault strategy types (src/vault/types.ts).
 *
 * SCOPE NOTE (documented narrowing, not a silent drop): PRD-04 §3.1 designs
 * a continuous, constrained Markowitz-style risk-penalized optimizer
 * (max w^T*mu - gamma/2*w^T*Sigma*w - penalties, solved over a full
 * covariance matrix). That is a substantial, separate quantitative-
 * modeling effort. This pass implements ONLY the 4 discrete triggers
 * (TR-01..TR-04) that PRD-04 §3.2 and PRD-07's PROOF-05 describe as
 * concrete, testable rules — the continuous optimizer is out of scope for
 * this implementation and is not silently approximated by the discrete
 * triggers; it would need to be a genuinely separate future task.
 */

export type AllocationTier = 'TIER_1_INSTANT' | 'TIER_2_ISOLATED' | 'TIER_3_FIXED_ALPHA';

export interface ProtocolAllocationTarget {
  protocol: 'aave-v3' | 'morpho-blue' | 'pendle' | 'silo-v2' | 'euler-v2';
  tier: AllocationTier;
  /** Market ID, vault address, or PT market address — protocol-specific, matches research module's SubjectContext.identifier. */
  marketIdentifier: string;
  currentWeightBps: number;
  targetWeightBps: number;
  currentAPY: number;
  utilizationRate?: number;
  maturityTimestamp?: number;
}

export interface RebalanceExecutionPlan {
  planId: string;
  sourceProtocol: string;
  targetProtocol: string;
  amountToShift: bigint;
  useFlashLoan: boolean;
  expectedYieldDeltaBps: number;
  /** Populated by the on-chain encoder (Task 14/15) — this engine never encodes calldata itself. */
  calldata: `0x${string}`;
  estimatedGasWei: bigint;
}

export interface AllocationEvaluationResult {
  shouldRebalance: boolean;
  plan?: RebalanceExecutionPlan;
  reason?: string;
}
