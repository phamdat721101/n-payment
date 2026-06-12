/**
 * Type declarations for `@open-wallet-standard/core` (peer-dep, optional).
 *
 * Covers only the surface n-payment v0.27 actually calls. The SDK exposes
 * additional internals that we deliberately don't re-declare to keep the
 * shim minimal. All methods are typed loosely — returns include `unknown`
 * fallbacks because the upstream SDK is in flux (v1.3.2, Apr 2026).
 */
declare module '@open-wallet-standard/core' {
  // ─── Read ─────────────────────────────────────────────────────────────────
  export interface WalletAccount {
    address: string;
    /** CAIP-2 chainId. */
    chainId: string;
    /** Optional family override; some SDK versions populate this. */
    family?: string;
    derivationPath?: string;
  }
  export interface Wallet {
    id: string;
    name: string;
    accounts: WalletAccount[];
    createdAt?: string;
  }
  export function getWallet(name: string): Wallet;
  export function listWallets(filter?: {
    chainType?: string;
    namePattern?: string;
    hasPolicy?: boolean;
  }): Promise<Wallet[]> | Wallet[];

  // ─── Sign ─────────────────────────────────────────────────────────────────
  export function signAndSend(
    wallet: string,
    chain: string,
    txJson: string,
    passphrase?: string | null,
    index?: number | null,
    rpcUrl?: string | null,
  ): Promise<{ txHash: string }>;

  export function signMessage(
    wallet: string,
    chain: string,
    message: string,
    passphrase?: string | null,
    encoding?: string | null,
  ): Promise<{ signature: string }>;

  export function signTransaction(
    wallet: string,
    chain: string,
    txJson: string,
    passphrase?: string | null,
    index?: number | null,
  ): Promise<{ signedTx: string; txHash?: string }>;

  // ─── Lifecycle (creation / import / export) ──────────────────────────────
  export function createWallet(opts: {
    name: string;
    chainType?: string;
    chains: string[];
    accountCount?: number;
    mnemonicStrength?: 128 | 256;
    passphrase?: string;
  }): Promise<Wallet>;

  export function importMnemonic(opts: {
    name: string;
    chainType?: string;
    chains: string[];
    passphrase?: string;
  }): Promise<Wallet>;

  export function importPrivateKey(opts: {
    name: string;
    key: string;
    family: string;
    passphrase?: string;
  }): Promise<Wallet>;

  export function importKeystore(opts: {
    name: string;
    file: string;
    password?: string;
    passphrase?: string;
  }): Promise<Wallet>;

  export function importWif(opts: { name: string; key: string; passphrase?: string }): Promise<Wallet>;
  export function importSolanaKeypair(opts: { name: string; file: string; passphrase?: string }): Promise<Wallet>;
  export function importSuiKeystore(opts: { name: string; file: string; passphrase?: string }): Promise<Wallet>;

  export function exportMnemonic(opts: { wallet: string; confirm: true }): Promise<string>;
  export function exportKeystore(opts: { wallet: string; account: string; output: string; password?: string }): Promise<void>;
  export function exportRaw(opts: { wallet: string; account: string; confirm: true }): Promise<string>;

  // ─── Backup / restore / recover ──────────────────────────────────────────
  export function backup(opts: { output: string; passphrase: string }): Promise<void>;
  export function restore(opts: { input: string; passphrase: string }): Promise<void>;
  export function recover(opts: {
    name: string;
    chains: string[];
    gapLimit?: number;
    chainType?: string;
  }): Promise<Wallet>;

  // ─── Active management ───────────────────────────────────────────────────
  export function lock(wallet: string): Promise<void>;
  export function unlock(wallet: string, passphrase?: string): Promise<void>;
  export function rotate(opts: { from: string; to: string; chains: string[] }): Promise<void>;
  export function deleteWallet(opts: { wallet: string; confirm: true }): Promise<void>;

  // ─── Policy ──────────────────────────────────────────────────────────────
  export const policy: {
    create(opts: {
      allowChains: string[];
      expiry?: string;
      customExec?: string;
      maxValuePerTx?: string;
    }): Promise<{ id: string }>;
    list(): Promise<Array<{ id: string; allowChains: string[]; expiry?: string }>>;
    get(id: string): Promise<{
      allowChains: string[];
      expiry?: string;
      customExec?: string;
      maxValuePerTx?: string;
    } | null>;
    delete(id: string): Promise<void>;
  };

  // ─── API key ─────────────────────────────────────────────────────────────
  export const apiKey: {
    create(opts: {
      name: string;
      wallets: string[];
      policy?: string;
      expires?: string;
    }): Promise<{ id: string; name: string; token: string; expires?: string }>;
    list(): Promise<Array<{ id: string; name: string; wallets: string[]; policy?: string; expires?: string }>>;
    revoke(id: string): Promise<void>;
  };

  // ─── Mnemonic utilities ──────────────────────────────────────────────────
  export const mnemonic: {
    generate(opts?: { words?: 12 | 24 }): Promise<string>;
    derive(opts: { mnemonic: string; chain: string; index?: number }): Promise<{ address: string; path: string }>;
  };
}
