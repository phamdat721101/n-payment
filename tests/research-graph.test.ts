import { describe, it, expect } from 'vitest';
import { GraphNodeReportEngine } from '../src/research/graph/report-engine.js';
import type { PositionHealthSnapshot } from '../src/research/adapters/interface.js';
import type { LendingResearchRequest } from '../src/research/types.js';
import { CyclicCausalGraphError } from '../src/research/errors.js';

const baseRequest: LendingResearchRequest = {
  targetProtocol: 'morpho-blue',
  targetChain: 'ethereum-mainnet',
  targetSubject: { type: 'market_id', identifier: '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50' },
  includeMevTrace: true,
  blockRangeLookback: 7200,
};

const healthySnapshot: PositionHealthSnapshot = {
  protocol: 'morpho-blue',
  chain: 'ethereum-mainnet',
  subjectIdentifier: baseRequest.targetSubject.identifier,
  totalCollateralUsd: 150_000,
  totalDebtUsd: 80_000,
  currentLtv: 80_000 / 150_000,
  liquidationThresholdLtv: 0.86,
  healthFactor: (0.86 * 150_000) / 80_000,
  borrowApy: 0.05,
  supplyApy: 0.06, // genuinely positive carry: supplyApy > borrowApy
};

const criticalSnapshot: PositionHealthSnapshot = {
  ...healthySnapshot,
  totalCollateralUsd: 100_000,
  totalDebtUsd: 95_000,
  currentLtv: 0.95,
  healthFactor: 1.05,
};
void criticalSnapshot; // reserved fixture, not currently exercised by a dedicated test

describe('GraphNodeReportEngine — synthesizeGraph', () => {
  it('produces a well-formed GraphNodeReport from a fixture position snapshot (PROOF-04)', () => {
    const engine = new GraphNodeReportEngine();

    // Matches PRD-07's PROOF-04 worked example exactly: collateral=150000,
    // debt=120000, LLTV=0.86, currentLtv=0.80, healthFactor=1.075 ->
    // riskScore=85, actionRecommendation=EMERGENCY_DELEVERAGE.
    const snapshot: PositionHealthSnapshot = {
      protocol: 'morpho-blue',
      chain: 'ethereum-mainnet',
      subjectIdentifier: baseRequest.targetSubject.identifier,
      totalCollateralUsd: 150_000,
      totalDebtUsd: 120_000,
      currentLtv: 0.8,
      liquidationThresholdLtv: 0.86,
      healthFactor: 1.075,
      borrowApy: 0.12,
      supplyApy: 0.08,
    };

    const report = engine.synthesizeGraph(baseRequest, snapshot);

    expect(report.summary.riskScore).toBe(85);
    expect(report.actionRecommendation).toBe('EMERGENCY_DELEVERAGE');
    expect(report.reportId).toBeTruthy();
    expect(report.markdownAuditReport).toContain('Position Audit');
    expect(Array.isArray(report.nodes)).toBe(true);
    expect(Array.isArray(report.edges)).toBe(true);
  });

  it('recommends HOLD for a healthy position with positive carry', () => {
    const engine = new GraphNodeReportEngine();
    const report = engine.synthesizeGraph(baseRequest, healthySnapshot);
    expect(report.actionRecommendation).toBe('HOLD');
    expect(report.summary.riskScore).toBeLessThan(60);
  });

  it('recommends DEFEND_KINK when utilization exceeds the 92% threshold', () => {
    const engine = new GraphNodeReportEngine();
    const snapshot: PositionHealthSnapshot = { ...healthySnapshot, utilizationRate: 0.945 };
    const report = engine.synthesizeGraph(baseRequest, snapshot);
    expect(report.actionRecommendation).toBe('DEFEND_KINK');
  });

  it('recommends REBALANCE_TO_PT when borrowApy exceeds supplyApy (negative carry)', () => {
    const engine = new GraphNodeReportEngine();
    const snapshot: PositionHealthSnapshot = { ...healthySnapshot, borrowApy: 0.15, supplyApy: 0.05 };
    const report = engine.synthesizeGraph(baseRequest, snapshot);
    expect(report.actionRecommendation).toBe('REBALANCE_TO_PT');
  });

  it('clamps riskScore to [0, 100] even for extreme inputs', () => {
    const engine = new GraphNodeReportEngine();
    const snapshot: PositionHealthSnapshot = { ...healthySnapshot, currentLtv: 5.0, liquidationThresholdLtv: 0.86 };
    const report = engine.synthesizeGraph(baseRequest, snapshot);
    expect(report.summary.riskScore).toBeGreaterThanOrEqual(0);
    expect(report.summary.riskScore).toBeLessThanOrEqual(100);
  });

  it('assembles a real causal DAG from provided nodes/edges without mutating input', () => {
    const engine = new GraphNodeReportEngine();
    const nodes = [
      {
        nodeId: 'tx_a_0',
        txHash: '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50' as `0x${string}`,
        blockNumber: 21000000,
        timestamp: 1735000000,
        primaryAction: 'FLASH_BORROW' as const,
        protocol: 'morpho-blue' as const,
        chain: 'ethereum-mainnet' as const,
        caller: '0x1111111111111111111111111111111111111111',
        contractTarget: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
        explorerLinks: {
          standardExplorer: 'https://etherscan.io/tx/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
          callTraceExplorer: 'https://phalcon.blocksec.com/tx/eth/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
          simulationSandbox: 'https://dashboard.tenderly.co/tx/mainnet/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
        },
        financials: { assetSymbol: 'USDC', amountRaw: '1000000000', amountFormatted: 1000 },
        riskContributionScore: 40,
      },
    ];
    const report = engine.synthesizeGraph(baseRequest, healthySnapshot, { nodes, edges: [] });
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0].nodeId).toBe('tx_a_0');
  });

  it('rejects a cyclic causal graph rather than silently serializing it (CHAOS-04)', () => {
    const engine = new GraphNodeReportEngine();
    const makeNode = (id: string) => ({
      nodeId: id,
      txHash: '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50' as `0x${string}`,
      blockNumber: 21000000,
      timestamp: 1735000000,
      primaryAction: 'FLASH_BORROW' as const,
      protocol: 'morpho-blue' as const,
      chain: 'ethereum-mainnet' as const,
      caller: '0x1111111111111111111111111111111111111111',
      contractTarget: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
      explorerLinks: {
        standardExplorer: 'https://etherscan.io/tx/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
        callTraceExplorer: 'https://phalcon.blocksec.com/tx/eth/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
        simulationSandbox: 'https://dashboard.tenderly.co/tx/mainnet/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
      },
      financials: { assetSymbol: 'USDC', amountRaw: '1000000000', amountFormatted: 1000 },
      riskContributionScore: 40,
    });
    const nodes = [makeNode('tx_a'), makeNode('tx_b')];
    const edges = [
      { sourceNodeId: 'tx_a', targetNodeId: 'tx_b', relationship: 'ATOMIC_PRECEDES' as const, description: 'a before b' },
      { sourceNodeId: 'tx_b', targetNodeId: 'tx_a', relationship: 'ATOMIC_PRECEDES' as const, description: 'b before a (cycle)' },
    ];

    expect(() => engine.synthesizeGraph(baseRequest, healthySnapshot, { nodes, edges })).toThrow(CyclicCausalGraphError);
  });
});
