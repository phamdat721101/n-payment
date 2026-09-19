/**
 * v0.31 — OnchainLendingResearchService public entry point.
 * Exported as the `n-payment/research` subpath (see package.json's
 * `exports` map), matching this repo's existing `./mcp`/`./spacerouter`
 * subpath-export convention.
 */

// Core types & schemas
export {
  LendingResearchRequestSchema,
  GraphNodeReportSchema,
  OnchainTxGraphNodeSchema,
  CausalEdgeSchema,
  ExplorerLinksSchema,
  LendingProtocolTypeSchema,
  LendingSubjectTypeSchema,
  ChainKeySchema,
  RESEARCH_SUPPORTED_CHAINS,
} from './types.js';
export type {
  LendingResearchRequest,
  GraphNodeReport,
  OnchainTxGraphNode,
  CausalEdge,
  ExplorerLinks,
  LendingProtocolType,
  LendingSubjectType,
  ResearchChainKey,
} from './types.js';

// Errors
export {
  InvalidSubjectIdentifierError,
  UnsupportedProtocolChainError,
  CyclicCausalGraphError,
  LiveRpcCallFailedError,
} from './errors.js';

// Explorer resolution
export { ExplorerResolver } from './explorer-resolver.js';

// Risk invariant math
export { calculateMacaulayDuration, calculateLIF, calculateNegativeCarryDays } from './risk/invariants.js';
export type { MacaulayDurationResult, NegativeCarryInputs } from './risk/invariants.js';

// Protocol adapters
export type { ProtocolAdapter, SubjectContext, PositionHealthSnapshot } from './adapters/interface.js';
export { MorphoBlueAdapter, MORPHO_BLUE_ADDRESS } from './adapters/morpho.js';
export { AaveV3Adapter } from './adapters/aave.js';
export { PendleAdapter, PENDLE_ROUTER_ADDRESS, PENDLE_PY_LP_ORACLE_ADDRESS } from './adapters/pendle.js';
export { EulerV2Adapter, EULER_VAULT_FACTORY_ADDRESS } from './adapters/euler.js';
export { SiloAdapter, SILO_FACTORY_ADDRESSES } from './adapters/silo.js';
export { ProtocolAdapterRegistry } from './adapters/registry.js';

// Facade
export { LendingResearchClient } from './client.js';

// Causal DAG graph engine
export { assertAcyclic } from './graph/builder.js';
export { GraphNodeReportEngine } from './graph/report-engine.js';
export type { GraphInputs } from './graph/report-engine.js';
