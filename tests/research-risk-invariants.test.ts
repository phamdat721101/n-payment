import { describe, it, expect } from 'vitest';
import {
  calculateMacaulayDuration,
  calculateLIF,
  calculateNegativeCarryDays,
} from '../src/research/risk/invariants.js';

describe('risk/invariants — Macaulay duration sensitivity', () => {
  it('computes modified duration for a 180-day / 14% implied-yield PT (PRD worked example)', () => {
    // tau = 180/365 = 0.4932; D_mod = tau / (1 + r) = 0.4932 / 1.14 ≈ 0.4327
    const result = calculateMacaulayDuration(180, 0.14);
    expect(result.modifiedDuration).toBeCloseTo(0.4327, 2);
  });

  it('estimates a negative price delta for a positive yield shock', () => {
    const result = calculateMacaulayDuration(180, 0.14);
    // Yield surges +1400bps (0.14 -> 0.28): deltaP ≈ -D_mod * deltaR
    const priceDelta = result.estimatePriceDelta(0.14);
    expect(priceDelta).toBeLessThan(0);
    expect(priceDelta).toBeLessThan(-0.05); // matches PRD-07's ">5% price drop" assertion
  });

  it('returns null (not NaN/Infinity) when time-to-maturity is zero or negative', () => {
    const result = calculateMacaulayDuration(0, 0.14);
    expect(result.modifiedDuration).toBeNull();
  });
});

describe('risk/invariants — Liquidation Incentive Factor (LIF)', () => {
  it('computes LIF for Morpho Blue 86% LLTV with the default 0.3 cursor (real Morpho Blue formula)', () => {
    // CORRECTED from the original PRD's formula (see invariants.ts doc comment) —
    // the PRD's `1/(1-LLTV*(1-fee))` does not match Morpho Blue's actual governance
    // parameter (liquidationCursor). Real formula: min(1.15, 1/(1 - cursor*(1-LLTV))).
    // Cross-checked against Berachain Bend's docs (a Morpho-Blue-derived fork):
    // "For LLTV 86%, LIF ~ 1.05" — matches this formula's ~1.044 to the same precision.
    const lif = calculateLIF(0.86, 0.3);
    expect(lif).toBeCloseTo(1.044, 2);
  });

  it('uses cursor=0.3 as the documented default when omitted', () => {
    expect(calculateLIF(0.86)).toBeCloseTo(calculateLIF(0.86, 0.3), 6);
  });

  it('never exceeds the hard 1.15 upper bound even for extreme LLTV/cursor inputs', () => {
    const lif = calculateLIF(0.99, 1.0);
    expect(lif).toBeLessThanOrEqual(1.15);
  });

  it('never drops below 1.0 for valid LLTV/cursor inputs', () => {
    const lif = calculateLIF(0.5, 0.1);
    expect(lif).toBeGreaterThanOrEqual(1.0);
  });
});

describe('risk/invariants — negative carry days-to-liquidation', () => {
  it('returns null when borrow APY does not exceed supply/collateral APY (no negative carry)', () => {
    const days = calculateNegativeCarryDays({
      borrowApy: 0.05,
      supplyApy: 0.08,
      collateralUsd: 150_000,
      debtUsd: 100_000,
      liquidationThresholdLtv: 0.86,
    });
    expect(days).toBeNull();
  });

  it('returns null (not NaN) when debt is zero, avoiding division by zero', () => {
    const days = calculateNegativeCarryDays({
      borrowApy: 0.12,
      supplyApy: 0.05,
      collateralUsd: 150_000,
      debtUsd: 0,
      liquidationThresholdLtv: 0.86,
    });
    expect(days).toBeNull();
  });

  it('computes a positive finite days-to-liquidation for a genuine negative-carry position', () => {
    const days = calculateNegativeCarryDays({
      borrowApy: 0.12,
      supplyApy: 0.08,
      collateralUsd: 150_000,
      debtUsd: 120_000,
      liquidationThresholdLtv: 0.86,
    });
    expect(days).not.toBeNull();
    expect(days as number).toBeGreaterThan(0);
    expect(Number.isFinite(days)).toBe(true);
  });
});
