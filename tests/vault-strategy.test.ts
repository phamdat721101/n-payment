import { describe, it, expect, vi } from 'vitest';
import { DeFiAllocationStrategyEngine } from '../src/vault/DeFiAllocationStrategyEngine.js';
import type { ProtocolAllocationTarget } from '../src/vault/types.js';

function makeMockResearchClient(riskScore: number) {
  return {
    auditLendingPosition: vi.fn(async () => ({
      protocol: 'morpho-blue',
      chain: 'ethereum-mainnet',
      subjectIdentifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
      totalCollateralUsd: 100_000,
      totalDebtUsd: 50_000,
      currentLtv: 0.5,
      liquidationThresholdLtv: 0.86,
      healthFactor: riskScore >= 80 ? 1.02 : 1.6,
      borrowApy: 0.09,
      supplyApy: 0.05,
      utilizationRate: riskScore >= 80 ? 0.94 : 0.5,
    })),
  };
}

describe('DeFiAllocationStrategyEngine — TR-02 Kink Defense Guard', () => {
  it('triggers a KINK-RELIEF rebalance to aave-v3 when Morpho utilization exceeds 92.5% (PROOF-05)', async () => {
    const mockResearchClient = makeMockResearchClient(80);
    const strategy = new DeFiAllocationStrategyEngine(mockResearchClient as any, '0x1111111111111111111111111111111111111111', 1_000_000n);

    const allocations: ProtocolAllocationTarget[] = [
      {
        protocol: 'morpho-blue',
        tier: 'TIER_2_ISOLATED',
        marketIdentifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
        currentWeightBps: 5000,
        targetWeightBps: 5000,
        currentAPY: 0.09,
        utilizationRate: 0.94,
      },
    ];

    const result = await strategy.evaluateAllocations(allocations);

    expect(result.shouldRebalance).toBe(true);
    expect(result.plan?.targetProtocol).toBe('aave-v3');
    expect(result.plan?.sourceProtocol).toBe('morpho-blue');
    expect(result.plan?.useFlashLoan).toBe(false);
  });

  it('does not trigger a rebalance when Morpho utilization is safely below the 92.5% threshold', async () => {
    const mockResearchClient = makeMockResearchClient(10);
    const strategy = new DeFiAllocationStrategyEngine(mockResearchClient as any, '0x1111111111111111111111111111111111111111', 1_000_000n);

    const allocations: ProtocolAllocationTarget[] = [
      {
        protocol: 'morpho-blue',
        tier: 'TIER_2_ISOLATED',
        marketIdentifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
        currentWeightBps: 5000,
        targetWeightBps: 5000,
        currentAPY: 0.09,
        utilizationRate: 0.5,
      },
    ];

    const result = await strategy.evaluateAllocations(allocations);
    expect(result.shouldRebalance).toBe(false);
  });
});

describe('DeFiAllocationStrategyEngine — TR-01 PT Discount Arbitrage', () => {
  it('triggers a PT-ARBITRAGE rebalance when the Pendle/Morpho implied-yield spread reaches >= 350 bps', async () => {
    const mockResearchClient = makeMockResearchClient(10);
    const strategy = new DeFiAllocationStrategyEngine(mockResearchClient as any, '0x1111111111111111111111111111111111111111', 1_000_000n);

    const allocations: ProtocolAllocationTarget[] = [
      {
        protocol: 'morpho-blue',
        tier: 'TIER_2_ISOLATED',
        marketIdentifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
        currentWeightBps: 5000,
        targetWeightBps: 5000,
        currentAPY: 0.08, // 8.0%
        utilizationRate: 0.5,
      },
      {
        protocol: 'pendle',
        tier: 'TIER_3_FIXED_ALPHA',
        marketIdentifier: '0x34280882267ffa6383b363e278b027be083bbe3b',
        currentWeightBps: 2500,
        targetWeightBps: 3500,
        currentAPY: 0.125, // 12.5% -> spread = 450 bps >= 350 bps
      },
    ];

    const result = await strategy.evaluateAllocations(allocations);

    expect(result.shouldRebalance).toBe(true);
    expect(result.plan?.targetProtocol).toBe('pendle');
    expect(result.plan?.sourceProtocol).toBe('morpho-blue');
    expect(result.plan?.useFlashLoan).toBe(true);
    expect(result.plan?.expectedYieldDeltaBps).toBe(450);
  });

  it('does not trigger PT arbitrage when the spread is below 350 bps', async () => {
    const mockResearchClient = makeMockResearchClient(10);
    const strategy = new DeFiAllocationStrategyEngine(mockResearchClient as any, '0x1111111111111111111111111111111111111111', 1_000_000n);

    const allocations: ProtocolAllocationTarget[] = [
      {
        protocol: 'morpho-blue',
        tier: 'TIER_2_ISOLATED',
        marketIdentifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
        currentWeightBps: 5000,
        targetWeightBps: 5000,
        currentAPY: 0.08,
        utilizationRate: 0.5,
      },
      {
        protocol: 'pendle',
        tier: 'TIER_3_FIXED_ALPHA',
        marketIdentifier: '0x34280882267ffa6383b363e278b027be083bbe3b',
        currentWeightBps: 2500,
        targetWeightBps: 2500,
        currentAPY: 0.09, // spread = 100bps < 350bps
      },
    ];

    const result = await strategy.evaluateAllocations(allocations);
    expect(result.shouldRebalance).toBe(false);
  });

  it('does not trigger PT arbitrage when Pendle allocation already at/above the 35% weight cap', async () => {
    const mockResearchClient = makeMockResearchClient(10);
    const strategy = new DeFiAllocationStrategyEngine(mockResearchClient as any, '0x1111111111111111111111111111111111111111', 1_000_000n);

    const allocations: ProtocolAllocationTarget[] = [
      {
        protocol: 'morpho-blue',
        tier: 'TIER_2_ISOLATED',
        marketIdentifier: '0x2222222222222222222222222222222222222222222222222222222222222222',
        currentWeightBps: 5000,
        targetWeightBps: 5000,
        currentAPY: 0.08,
        utilizationRate: 0.5,
      },
      {
        protocol: 'pendle',
        tier: 'TIER_3_FIXED_ALPHA',
        marketIdentifier: '0x34280882267ffa6383b363e278b027be083bbe3b',
        currentWeightBps: 3500, // already at cap
        targetWeightBps: 3500,
        currentAPY: 0.15,
      },
    ];

    const result = await strategy.evaluateAllocations(allocations);
    expect(result.shouldRebalance).toBe(false);
  });
});
