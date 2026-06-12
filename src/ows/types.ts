/**
 * OWS wallet types — segregated interfaces (Interface Segregation Principle).
 *
 * v0.27 adds CAIP-2-native multichain types alongside the legacy v0.25 surface.
 * All v0.25 types (`OWSConfig`, `OWSSignResult`) are preserved unchanged.
 */

// ─── v0.25 legacy types — preserved verbatim ─────────────────────────────────

export interface OWSConfig {
  /** Wallet name (`~/.ows/wallets/<uuid>/meta.json` `name` field). */
  wallet: string;
  /** Optional EVM private key for legacy / CI / serverless mode. Disables OWS-native path. */
  privateKey?: string;
  /** Auto-request testnet faucet on insufficient gas. */
  autoFaucet?: boolean;
  /** Override path to `ows` CLI binary (default: PATH lookup). */
  cliPath?: string;
  /** Optional pre-signing policy ID (read-only in v0.27). */
  policyId?: string;
}

export interface OWSSignResult {
  txHash: string;
  blockNumber: bigint;
}

// ─── v0.27 chain-family types ────────────────────────────────────────────────

/** OWS chain family — derived from CAIP-2 namespace via `caip2.ts:resolveFamily`. */
export type ChainFamily =
  | 'evm'
  | 'solana'
  | 'bitcoin'
  | 'cosmos'
  | 'tron'
  | 'ton'
  | 'sui'
  | 'xrpl'
  | 'spark'
  | 'filecoin'
  | 'near';

/** Row in `caip2.ts:FAMILY_TABLE`. */
export interface FamilySpec {
  readonly family: ChainFamily;
  readonly namespace: string;
  readonly curve: 'secp256k1' | 'Ed25519';
  readonly slip44: number;
  readonly derivationTemplate: string;
  readonly addressFormat: string;
}

/** Result of `OWSWallet.signTransaction` / `signAndSend` on the CAIP-2 path. */
export interface SignedTx {
  /** Family-native tx hash / signature blob. */
  txHash: string;
  /** Optional block number (only EVM-style chains populate this synchronously). */
  blockNumber?: bigint;
  /** Family the tx was signed for, for downstream observers. */
  family: ChainFamily;
}

// ─── Segregated interfaces (Interface Segregation Principle) ─────────────────

/** Pure CAIP-2 multichain signer interface (no lifecycle, no policy). */
export interface Signer {
  getAddress(caip2: string): Promise<string>;
  signMessage(caip2: string, message: string): Promise<string>;
  signTransaction(tx: unknown, caip2: string): Promise<SignedTx>;
  signAndSend(caip2: string, tx: unknown): Promise<SignedTx>;
}

/** Lifecycle ops (creation, import, export, backup, recovery, etc.). */
export interface Lifecycle {
  createWallet(opts: CreateWalletOpts): Promise<WalletDescriptor>;
  importMnemonic(opts: { name: string }): Promise<WalletDescriptor>;
  importPrivateKey(opts: { name: string; key: string; family: ChainFamily }): Promise<WalletDescriptor>;
  exportMnemonic(opts: { wallet: string; confirm: true }): Promise<string>;
  backupVault(opts: { output: string; passphraseEnv: string }): Promise<void>;
  restoreVault(opts: { input: string; passphraseEnv?: string }): Promise<void>;
  recover(opts: { name: string; chains: string[]; gapLimit?: number }): Promise<WalletDescriptor>;
  lock(wallet: string): Promise<void>;
  unlock(wallet: string, passphrase?: string): Promise<void>;
  rotate(opts: { from: string; to: string; chains: string[] }): Promise<void>;
  discover(opts: DiscoverOpts): Promise<WalletDescriptor[]>;
  delete(opts: { wallet: string; confirm: true }): Promise<void>;
}

/** Pre-signing policy CRUD. */
export interface PolicyManager {
  createPolicy(opts: PolicyDef): Promise<PolicyId>;
  listPolicies(): Promise<PolicySummary[]>;
  getPolicy(id: PolicyId): Promise<PolicyDef | null>;
  deletePolicy(id: PolicyId): Promise<void>;
}

/** Scoped API-key issuance for sub-agent isolation. */
export interface KeyManager {
  createApiKey(opts: ApiKeyOpts): Promise<ApiKeyIssued>;
  listApiKeys(): Promise<ApiKeySummary[]>;
  revokeApiKey(id: ApiKeyId): Promise<void>;
}

// ─── Value types referenced above ────────────────────────────────────────────

export interface CreateWalletOpts {
  name: string;
  chains: string[]; // CAIP-2 list
  mnemonicStrength?: 128 | 256;
  passphrase?: string;
}

export interface WalletDescriptor {
  id: string;
  name: string;
  accounts: WalletAccount[];
  createdAt: string;
}

export interface WalletAccount {
  address: string;
  chainId: string; // CAIP-2
  family: ChainFamily;
  derivationPath: string;
}

export interface DiscoverOpts {
  chainType?: ChainFamily;
  namePattern?: string;
  hasPolicy?: boolean;
}

export type PolicyId = string;

export interface PolicyDef {
  allowChains: string[]; // CAIP-2 list
  expiry?: string;        // ISO-8601
  customExec?: string;    // path to executable
  maxValuePerTx?: string; // human-readable, e.g. "5.00 USD"
}

export interface PolicySummary {
  id: PolicyId;
  allowChains: string[];
  expiry?: string;
}

export type ApiKeyId = string;

export interface ApiKeyOpts {
  name: string;
  wallets: string[]; // wallet IDs
  policy?: PolicyId;
  expires?: string;  // ISO-8601
}

export interface ApiKeyIssued {
  id: ApiKeyId;
  name: string;
  /** Plaintext token — shown ONCE. Caller must persist; cannot be recovered. */
  token: string;
  expires?: string;
}

export interface ApiKeySummary {
  id: ApiKeyId;
  name: string;
  wallets: string[];
  policy?: PolicyId;
  expires?: string;
}
