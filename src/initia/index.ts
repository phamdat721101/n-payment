// v0.23 — Initia (Cosmos-SDK + iUSD) public surface for n-payment.
//
// Asset registry (Task 1): INITIA_ASSETS, getInitiaAsset, parse/format helpers
// Cosmos signer client (Task 2): InitiaClient
// iUSD payment adapter (Task 3): InitiaIusdAdapter (lives in ../adapters/initia-iusd.ts)
// Bridge corridor (Tasks 4-6): selectIusdCorridor, SkipApiClient, LayerZeroAusdClient

export {
  INITIA_ASSETS,
  getInitiaAsset,
  assertVerifiedDenom,
  parseInitiaAmount,
  formatInitiaAmount,
} from './assets.js';
export type { InitiaAsset, InitiaAssetSymbol } from './assets.js';

export type {
  InitiaConfig,
  InitiaNetwork,
  InitiaChainKey,
  IusdConfig,
  IusdCorridor,
  IusdCorridorStep,
  IusdCorridorResult,
  IusdCorridorInput,
  SkipQuoteRequest,
  SkipQuoteResponse,
} from './types.js';

export { InitiaClient, mnemonicSigner } from './client.js';
export type { InitiaClientConfig, InitiaSigner, BroadcastResult } from './client.js';

export {
  selectIusdCorridor,
  SkipApiClient,
  LayerZeroAusdClient,
  IusdBridgeOrchestrator,
} from './corridor.js';
export type {
  SkipApiClientConfig,
  LayerZeroAusdClientConfig,
  IusdBridgeOrchestratorConfig,
} from './corridor.js';
