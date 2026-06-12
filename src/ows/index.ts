// ─── v0.27 — CAIP-2-native multichain wallet + full lifecycle facade ─────────
// Back-compat: every v0.25 export is preserved unchanged.

// Wallet — class kept as OWSWallet; OwsWallet alias added.
export { OWSWallet, OwsWallet } from './wallet.js';
export type { TransactionRequest } from './wallet.js';

// Lifecycle facade.
export { ows } from './lifecycle.js';

// CAIP-2 resolver (pure functions; useful for adapter authors).
export {
  FAMILY_TABLE,
  parseCaip2,
  resolveFamily,
  resolveSpec,
  getDerivationPath,
  getSlip44,
  extractEvmChainId,
  listSupportedNamespaces,
} from './caip2.js';

// Driver helpers.
export { createOWSDriver, listAvailableFamilies } from './cli-driver.js';
export type { OWSDriver } from './cli-driver.js';

// Types — preserve legacy + export new public types.
export type {
  OWSConfig,
  OWSSignResult,
  ChainFamily,
  FamilySpec,
  SignedTx,
  WalletDescriptor,
  WalletAccount,
  CreateWalletOpts,
  DiscoverOpts,
  PolicyDef,
  PolicyId,
  PolicySummary,
  ApiKeyId,
  ApiKeyOpts,
  ApiKeyIssued,
  ApiKeySummary,
  Signer,
  Lifecycle,
  PolicyManager,
  KeyManager,
} from './types.js';
