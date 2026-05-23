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
  XRP_SCALE,
  DIRECT_MINTING_MEMO_PREFIX,
} from './direct-minting.js';
export type {
  DirectMintingFees,
  DirectMintingQuote,
  DirectMintingPreflight,
} from './direct-minting.js';

export {
  FlareBridgeClient,
  createFlareBridgeClient,
} from './bridge.js';
export type {
  FlareBridgeConfig,
  FlareMintParams,
  FlareMintReceipt,
} from './bridge.js';
