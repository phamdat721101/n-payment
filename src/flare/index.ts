// Public Flare FXRP bridge surface (v0.15).

export {
  FlareClient,
  FlareContractsRegistry,
  createFlareClient,
  FLARE_CONTRACT_REGISTRY_ADDRESS,
} from './client.js';
export type { FlareClientConfig, FlareContractName } from './client.js';

export {
  getPersonalAccountAddress,
  isSmartAccount,
  getOperatorXrplAddresses,
  getFxrpAddress,
  getFxrpBalance,
  getFxrpDecimals,
  getVaults,
  getAgentVaults,
} from './state.js';
export type { FlareVault, FlareAgentVault } from './state.js';

export {
  parseXrpDropsAmount,
  formatXrpDropsAmount,
  computeDirectMintingQuote,
  encodeDirectMintingMemo32,
  toXrplMemoHex,
  getDirectMintingFees,
  getDirectMintingPaymentAddress,
  preflightDirectMintingLimits,
  // v0.22.1 — redemption
  computeRedemptionQuote,
  getRedemptionFees,
  getLotSize,
  XRP_SCALE,
  DIRECT_MINTING_MEMO_PREFIX,
} from './direct-minting.js';
export type {
  DirectMintingFees,
  DirectMintingQuote,
  DirectMintingPreflight,
  // v0.22.1 — redemption
  RedemptionFees,
  RedemptionQuote,
} from './direct-minting.js';

export {
  FlareBridgeClient,
  createFlareBridgeClient,
} from './bridge.js';
export type {
  FlareBridgeConfig,
  FlareMintParams,
  FlareMintReceipt,
  // v0.22.1 — redemption
  FlareRedeemParams,
  FlareRedeemReceipt,
  FlareRedemptionStatus,
  PollRedemptionOptions,
} from './bridge.js';

// ─── v0.19: x402 (MockUSDT0) — buyer adapter + merchant settle + deploy helper ─
export {
  FlareX402Adapter,
  verifyAndSettleFlareX402,
  decodeFlareX402Header,
  buildFlareX402Challenge,
  deployFlareX402Contracts,
  X402_FACILITATOR_ABI,
} from './x402.js';
export type {
  FlareX402Payload,
  VerifyAndSettleParams,
  VerifyAndSettleResult,
  ContractArtifact,
  DeployFlareX402Params,
  DeployFlareX402Result,
} from './x402.js';

// ─── v0.19: Gasless FXRP forwarder — client + relayer + deploy helper ─────────
export {
  FlareGaslessForwarderClient,
  createGaslessExecutor,
  deployFlareGaslessForwarder,
  PAYMENT_REQUEST_TYPES,
  FORWARDER_ABI,
} from './gasless.js';
export type {
  FlareGaslessClientConfig,
  FlarePaymentRequest,
  FlareGaslessStatus,
  FlareGaslessExecuteResult,
  GaslessRelayerHandlerConfig,
  DeployFlareGaslessParams,
} from './gasless.js';
