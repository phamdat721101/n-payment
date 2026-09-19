/**
 * v0.31 — Financial risk invariant math for OnchainLendingResearchService.
 *
 * Pure, dependency-free functions (no viem/RPC calls) so they're
 * independently unit-testable and reusable by any adapter (Morpho, Aave,
 * Pendle, Euler, Silo) that produces a normalized PositionHealthSnapshot.
 *
 * Formulas ported from PRD-01/PRD-03 (standard zero-coupon-bond duration
 * math and Morpho-style liquidation-incentive-factor math — not something
 * specific to this SDK). Per CHAOS-03 (PRD-07), all functions return `null`
 * instead of NaN/Infinity on degenerate (zero/negative) inputs rather than
 * propagating an unusable numeric result to callers.
 */

export interface MacaulayDurationResult {
  /** tau = (days to maturity) / 365, or null if daysToMaturity <= 0. */
  timeToMaturityYears: number | null;
  /** D_mod = tau / (1 + r); null if timeToMaturityYears is null. */
  modifiedDuration: number | null;
  /** Estimates ΔP_PT ≈ -D_mod * Δr for a given yield shock Δr. Returns 0 if duration is null. */
  estimatePriceDelta: (deltaR: number) => number;
}

/**
 * Zero-coupon bond Macaulay/modified duration sensitivity for a Pendle PT
 * (or any fixed-maturity, zero-coupon collateral instrument).
 *
 *   tau = daysToMaturity / 365
 *   D_mod = tau / (1 + impliedYield)
 *   ΔP_PT ≈ -D_mod * Δr
 */
export function calculateMacaulayDuration(daysToMaturity: number, impliedYield: number): MacaulayDurationResult {
  if (!Number.isFinite(daysToMaturity) || daysToMaturity <= 0) {
    return {
      timeToMaturityYears: null,
      modifiedDuration: null,
      estimatePriceDelta: () => 0,
    };
  }

  const timeToMaturityYears = daysToMaturity / 365;
  const modifiedDuration = timeToMaturityYears / (1 + impliedYield);

  return {
    timeToMaturityYears,
    modifiedDuration,
    estimatePriceDelta: (deltaR: number) => -modifiedDuration * deltaR,
  };
}

/**
 * Liquidation Incentive Factor (LIF) — Morpho Blue's real, protocol-defined
 * formula, verified against Morpho's own docs (docs.morpho.org/developers/
 * contracts/midnight/ — "liquidationCursor ... Controls the liquidation
 * incentive") plus an independent third-party numeric cross-check
 * (mixbytes.io's Morpho Blue technical writeup; Berachain Bend docs, a
 * Morpho-Blue-derived fork, cite "LLTV 86% -> LIF ~1.05", matching this
 * formula's ~1.044 output for the same LLTV to 2 decimal places).
 *
 * CORRECTION NOTE: the original PRD-01/PRD-03 design docs specified
 * `LIF = min(1/(1 - LLTV*(1-fee)), 1.15)` and claimed this equals 1.095 for
 * LLTV=0.86, fee=0.05 — that formula is NOT Morpho Blue's real formula (it
 * conflates a generic "liquidation fee" concept with Morpho's actual
 * governance-set `liquidationCursor` parameter) and does not even
 * numerically reproduce the PRD's own claimed 1.095 result (it actually
 * evaluates to ~5.46, clamped to the 1.15 ceiling). The real formula below
 * replaces it.
 *
 *   LIF = min(maxLIF, 1 / (1 - cursor * (1 - LLTV)))
 *
 * where maxLIF = 1.15 and cursor defaults to 0.3 (Morpho Blue's governance-
 * set liquidationCursor for most markets; pass the market's actual cursor
 * if a live adapter has read it on-chain).
 */
export function calculateLIF(lltv: number, cursor = 0.3): number {
  const maxLIF = 1.15;
  const raw = 1 / (1 - cursor * (1 - lltv));
  return Math.min(Math.max(raw, 1.0), maxLIF);
}

export interface NegativeCarryInputs {
  borrowApy: number;
  supplyApy: number;
  collateralUsd: number;
  debtUsd: number;
  liquidationThresholdLtv: number;
}

/**
 * Estimated days until a negative-carry position (borrowApy > supplyApy)
 * erodes enough collateral headroom to breach the liquidation threshold.
 *
 *   carryDeficit = borrowApy - supplyApy
 *   daysToLiquidation = (ln(collateral * LLTV / debt) / carryDeficit) * 365
 *
 * Returns null (never NaN/Infinity) when:
 *  - there is no negative carry (borrowApy <= supplyApy) — position isn't
 *    eroding, so "days to liquidation" from carry alone is undefined;
 *  - debt is zero — division by zero;
 *  - the resulting log argument is non-positive (already underwater).
 */
export function calculateNegativeCarryDays(inputs: NegativeCarryInputs): number | null {
  const { borrowApy, supplyApy, collateralUsd, debtUsd, liquidationThresholdLtv } = inputs;

  const carryDeficit = borrowApy - supplyApy;
  if (carryDeficit <= 0) return null;
  if (debtUsd <= 0) return null;

  const logArg = (collateralUsd * liquidationThresholdLtv) / debtUsd;
  if (!Number.isFinite(logArg) || logArg <= 0) return null;

  const days = (Math.log(logArg) / carryDeficit) * 365;
  if (!Number.isFinite(days)) return null;

  return Math.max(days, 0);
}
