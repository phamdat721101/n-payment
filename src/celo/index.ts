/**
 * v0.25 — Celo public surface barrel.
 *
 * Three primitives ship together:
 *   1. `CeloFeeAbstractedTransactor`  — CIP-64 fee abstraction wrapper (Task 2).
 *   2. `selectMentoCorridor` / `MentoBrokerClient` — Mento corridor (Task 4).
 *   3. `CeloAgentVisaTracker` — Tourist → Work → Citizenship tier accumulator (Task 5).
 */
export {
  CeloFeeAbstractedTransactor,
  TRANSFER_WITH_AUTHORIZATION_ABI,
  type CeloChainKey,
  type CeloPayAsset,
  type CeloFeeAbstractedTransactorOptions,
} from './fee-abstraction.js';

// Tasks 4 + 5 will populate these re-exports as the files land.
// Keeping them commented out here lets typecheck pass incrementally.
export {
  MENTO_ASSETS,
  selectMentoCorridor,
  type MentoAssetSymbol,
  type MentoAsset,
  type MentoCorridorInput,
  type MentoCorridorDecision,
  type MentoCorridorLeg,
} from './mento.js';
export { MentoBrokerClient, type MentoBrokerClientOptions } from './mento-broker.js';

export {
  CeloAgentVisaTracker,
  computeAgentVisaTier,
  MemoryAgentVisaStorage,
  JsonFileAgentVisaStorage,
  type CeloAgentVisaTrackerOptions,
} from './agent-visa.js';
