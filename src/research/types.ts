/**
 * v0.31 — OnchainLendingResearchService: Zod schema layer.
 *
 * Corrects the original PRD-v031 design in two ways confirmed during
 * implementation planning:
 *  1. `targetChain` reuses this SDK's real `ChainKey` (src/types.ts),
 *     extended additively with `arbitrum-one` — not a separate, ad-hoc
 *     ChainKeySchema as the PRD sketched.
 *  2. `LendingSubjectTypeSchema` includes `vault_address` as a first-class
 *     type because Euler v2 / Silo v2 are permissionless per-asset-pair
 *     vault factories with no singleton market/pool address to default to
 *     (see src/research/adapters/euler.ts, silo.ts).
 */
import { z } from 'zod';
import type { ChainKey } from '../types.js';

// ─── Supported chains for lending research (subset of the SDK-wide ChainKey) ──

export const RESEARCH_SUPPORTED_CHAINS = [
  'ethereum-mainnet',
  'base-mainnet',
  'arbitrum-one',
  'optimism-mainnet',
] as const satisfies readonly ChainKey[];

export const ChainKeySchema = z.enum(RESEARCH_SUPPORTED_CHAINS);
/** Chain subset supported by lending research adapters — distinct from (a subset of) the SDK-wide `ChainKey`. */
export type ResearchChainKey = z.infer<typeof ChainKeySchema>;

// ─── Protocol & subject enums ──────────────────────────────────────────────

export const LendingProtocolTypeSchema = z.enum([
  'morpho-blue',
  'aave-v3',
  'pendle',
  'euler-v2',
  'silo-v2',
  'auto',
]);
export type LendingProtocolType = z.infer<typeof LendingProtocolTypeSchema>;

export const LendingSubjectTypeSchema = z.enum([
  'market_id',
  'borrower',
  'vault_address',
  'reserve_asset',
  'pt_address',
]);
export type LendingSubjectType = z.infer<typeof LendingSubjectTypeSchema>;

// ─── Input contract: LendingResearchRequest ────────────────────────────────

export const LendingResearchRequestSchema = z.object({
  targetProtocol: LendingProtocolTypeSchema,
  targetChain: ChainKeySchema,
  targetSubject: z.object({
    type: LendingSubjectTypeSchema,
    /** 0x-prefixed EVM address (40 hex chars) or 32-byte market/vault hash (64 hex chars). */
    identifier: z.string().regex(/^0x[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/, 'Invalid address or market hash'),
  }),
  includeMevTrace: z.boolean().default(true),
  blockRangeLookback: z.number().int().min(100).max(50000).default(7200),
});
export type LendingResearchRequest = z.infer<typeof LendingResearchRequestSchema>;

// ─── Output contract: GraphNodeReport ──────────────────────────────────────

export const ExplorerLinksSchema = z.object({
  standardExplorer: z.string().url(),
  callTraceExplorer: z.string().url(),
  simulationSandbox: z.string().url(),
});
export type ExplorerLinks = z.infer<typeof ExplorerLinksSchema>;

export const OnchainTxGraphNodeSchema = z.object({
  nodeId: z.string(),
  txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  blockNumber: z.number().int(),
  timestamp: z.number().int(),
  primaryAction: z.enum([
    'FLASH_BORROW',
    'LIQUIDATE_CALL',
    'SWAP_PT_COLLATERAL',
    'REPAY_DEBT',
    'MEV_BUILDER_BRIBE',
    'SUPPLY_COLLATERAL',
    'WITHDRAW_LIQUIDITY',
  ]),
  protocol: LendingProtocolTypeSchema,
  chain: ChainKeySchema,
  caller: z.string(),
  contractTarget: z.string(),
  explorerLinks: ExplorerLinksSchema,
  financials: z.object({
    assetSymbol: z.string(),
    amountRaw: z.string(),
    amountFormatted: z.number(),
    usdValueEstimate: z.number().optional(),
  }),
  riskContributionScore: z.number().min(0).max(100),
});
export type OnchainTxGraphNode = z.infer<typeof OnchainTxGraphNodeSchema>;

export const CausalEdgeSchema = z.object({
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  relationship: z.enum([
    'ATOMIC_PRECEDES',
    'FUNDS_DEPENDENCY',
    'LIQUIDATION_SEIZURE',
    'MEV_BRIBE_DESTINATION',
  ]),
  description: z.string(),
});
export type CausalEdge = z.infer<typeof CausalEdgeSchema>;

export const GraphNodeReportSchema = z.object({
  reportId: z.string(),
  generatedAt: z.number().int(),
  targetSubject: LendingResearchRequestSchema.shape.targetSubject,
  summary: z.object({
    riskScore: z.number().min(0).max(100),
    healthFactor: z.number(),
    estimatedDaysToLiquidation: z.number().nullable(),
    macaulayDurationDays: z.number().optional(),
    netCarryYieldBps: z.number(),
  }),
  nodes: z.array(OnchainTxGraphNodeSchema),
  edges: z.array(CausalEdgeSchema),
  actionRecommendation: z.enum([
    'HOLD',
    'REBALANCE_TO_PT',
    'DEFEND_KINK',
    'ROLLOVER_DEBT',
    'EMERGENCY_DELEVERAGE',
  ]),
  markdownAuditReport: z.string(),
});
export type GraphNodeReport = z.infer<typeof GraphNodeReportSchema>;
