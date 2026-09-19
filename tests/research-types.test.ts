import { describe, it, expect } from 'vitest';
import {
  LendingProtocolTypeSchema,
  LendingSubjectTypeSchema,
  LendingResearchRequestSchema,
  OnchainTxGraphNodeSchema,
  CausalEdgeSchema,
  GraphNodeReportSchema,
} from '../src/research/types.js';

describe('research/types — LendingResearchRequestSchema', () => {
  it('accepts a valid market_id request for morpho-blue', () => {
    const valid = {
      targetProtocol: 'morpho-blue',
      targetChain: 'ethereum-mainnet',
      targetSubject: {
        type: 'market_id',
        identifier: '0xfc91948b556d7529ad6f5318825286ed2c34d862427b4832817e880a7edbd160',
      },
    };
    const parsed = LendingResearchRequestSchema.parse(valid);
    expect(parsed.targetProtocol).toBe('morpho-blue');
    expect(parsed.includeMevTrace).toBe(true); // default
    expect(parsed.blockRangeLookback).toBe(7200); // default
  });

  it('accepts a valid vault_address request for euler-v2', () => {
    const valid = {
      targetProtocol: 'euler-v2',
      targetChain: 'ethereum-mainnet',
      targetSubject: {
        type: 'vault_address',
        identifier: '0x1111111111111111111111111111111111111111',
      },
    };
    expect(() => LendingResearchRequestSchema.parse(valid)).not.toThrow();
  });

  it('rejects a malformed (too-short) identifier', () => {
    const invalid = {
      targetProtocol: 'morpho-blue',
      targetChain: 'ethereum-mainnet',
      targetSubject: { type: 'market_id', identifier: '0xinvalid' },
    };
    expect(() => LendingResearchRequestSchema.parse(invalid)).toThrow();
  });

  it('rejects an unsupported protocol', () => {
    const invalid = {
      targetProtocol: 'compound-v2', // not in the 5 supported protocols
      targetChain: 'ethereum-mainnet',
      targetSubject: { type: 'market_id', identifier: '0x1111111111111111111111111111111111111111' },
    };
    expect(() => LendingResearchRequestSchema.parse(invalid)).toThrow();
  });

  it('rejects an unsupported chain', () => {
    const invalid = {
      targetProtocol: 'aave-v3',
      targetChain: 'not-a-real-chain',
      targetSubject: { type: 'borrower', identifier: '0x1111111111111111111111111111111111111111' },
    };
    expect(() => LendingResearchRequestSchema.parse(invalid)).toThrow();
  });

  it('applies documented defaults for includeMevTrace and blockRangeLookback', () => {
    const parsed = LendingResearchRequestSchema.parse({
      targetProtocol: 'aave-v3',
      targetChain: 'base-mainnet',
      targetSubject: { type: 'borrower', identifier: '0x2222222222222222222222222222222222222222' },
    });
    expect(parsed.includeMevTrace).toBe(true);
    expect(parsed.blockRangeLookback).toBe(7200);
  });

  it('rejects blockRangeLookback outside the documented [100, 50000] bounds', () => {
    const base = {
      targetProtocol: 'aave-v3' as const,
      targetChain: 'base-mainnet' as const,
      targetSubject: { type: 'borrower' as const, identifier: '0x2222222222222222222222222222222222222222' },
    };
    expect(() => LendingResearchRequestSchema.parse({ ...base, blockRangeLookback: 50 })).toThrow();
    expect(() => LendingResearchRequestSchema.parse({ ...base, blockRangeLookback: 100000 })).toThrow();
  });
});

describe('research/types — protocol & subject enums', () => {
  it('supports exactly the 5 real protocols plus auto', () => {
    const expected = ['morpho-blue', 'aave-v3', 'pendle', 'euler-v2', 'silo-v2', 'auto'];
    for (const p of expected) {
      expect(() => LendingProtocolTypeSchema.parse(p)).not.toThrow();
    }
  });

  it('supports vault_address as a distinct subject type (needed for Euler/Silo factory-discovery)', () => {
    expect(() => LendingSubjectTypeSchema.parse('vault_address')).not.toThrow();
  });
});

describe('research/types — GraphNodeReportSchema', () => {
  const validNode = {
    nodeId: 'tx_0x52940dc3_0',
    txHash: '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
    blockNumber: 21000000,
    timestamp: 1735000000,
    primaryAction: 'LIQUIDATE_CALL',
    protocol: 'morpho-blue',
    chain: 'ethereum-mainnet',
    caller: '0x1111111111111111111111111111111111111111',
    contractTarget: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    explorerLinks: {
      standardExplorer: 'https://etherscan.io/tx/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
      callTraceExplorer: 'https://phalcon.blocksec.com/tx/eth/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
      simulationSandbox: 'https://dashboard.tenderly.co/tx/mainnet/0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
    },
    financials: { assetSymbol: 'USDC', amountRaw: '100000000', amountFormatted: 100 },
    riskContributionScore: 85,
  };

  it('validates a well-formed node', () => {
    expect(() => OnchainTxGraphNodeSchema.parse(validNode)).not.toThrow();
  });

  it('rejects a node with an out-of-range riskContributionScore', () => {
    expect(() => OnchainTxGraphNodeSchema.parse({ ...validNode, riskContributionScore: 150 })).toThrow();
  });

  it('validates a well-formed causal edge', () => {
    const edge = {
      sourceNodeId: 'tx_0x52940dc3_0',
      targetNodeId: 'tx_0x52940dc3_1',
      relationship: 'ATOMIC_PRECEDES',
      description: 'Flash loan precedes liquidation call in the same block.',
    };
    expect(() => CausalEdgeSchema.parse(edge)).not.toThrow();
  });

  it('validates a full GraphNodeReport envelope', () => {
    const report = {
      reportId: 'REP-123-0xfc91948b',
      generatedAt: 1735000000,
      targetSubject: { type: 'market_id', identifier: '0xfc91948b556d7529ad6f5318825286ed2c34d862427b4832817e880a7edbd160' },
      summary: {
        riskScore: 42,
        healthFactor: 1.18,
        estimatedDaysToLiquidation: null,
        netCarryYieldBps: -150,
      },
      nodes: [validNode],
      edges: [],
      actionRecommendation: 'HOLD',
      markdownAuditReport: '### Position Audit',
    };
    expect(() => GraphNodeReportSchema.parse(report)).not.toThrow();
  });
});
