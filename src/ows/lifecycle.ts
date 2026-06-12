/**
 * OWS lifecycle facade — single namespace, single SDK adapter.
 *
 * SOLID:
 *   • S — every method is a thin async wrapper around one OWS SDK call.
 *   • O — adding a lifecycle op = one new function; no existing code changes.
 *   • L — every method returns a typed value or throws an `NPaymentError`.
 *   • I — segregated interfaces from `types.ts` (Lifecycle, PolicyManager, KeyManager).
 *   • D — depends on the loose `@open-wallet-standard/core` typedecl, not the impl.
 *
 * Sample-mistake avoidance:
 *   • Single `withSdk(fn)` helper wraps every call; no copy-pasted error handling.
 *   • Single `withCli(args, opts)` helper for `ows` CLI shell-out
 *     (uses `child_process.execFile` to avoid shell injection).
 *   • Plain function namespace (`export const ows = { ... }`) — no class state,
 *     no per-method fields, no inheritance.
 *
 * Performance: SDK is lazy-imported once per process (cached in `sdkPromise`).
 * CLI shell-outs only run for backup/restore/recover (operator actions).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { owsError } from '../errors.js';
import type {
  ChainFamily,
  CreateWalletOpts,
  DiscoverOpts,
  PolicyDef,
  PolicyId,
  PolicySummary,
  ApiKeyId,
  ApiKeyIssued,
  ApiKeyOpts,
  ApiKeySummary,
  WalletDescriptor,
} from './types.js';

const execFileAsync = promisify(execFile);

// ─── Lazy SDK loader (single source of truth) ────────────────────────────────

type OwsSdk = typeof import('@open-wallet-standard/core');
let sdkPromise: Promise<OwsSdk | null> | null = null;

function loadSdk(): Promise<OwsSdk | null> {
  if (!sdkPromise) {
    sdkPromise = import('@open-wallet-standard/core').then(
      (m) => m as unknown as OwsSdk,
      () => null,
    );
  }
  return sdkPromise;
}

/** Run an SDK-backed call; convert all SDK errors to typed NPaymentError. */
async function withSdk<T>(label: string, fn: (sdk: OwsSdk) => Promise<T>): Promise<T> {
  const sdk = await loadSdk();
  if (!sdk) throw owsError('OWS_SDK_NOT_INSTALLED', `lifecycle.${label} requires @open-wallet-standard/core`);
  try {
    return await fn(sdk);
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    // Map common SDK errors to typed codes.
    if (/not found|no such wallet/i.test(message)) {
      throw owsError('OWS_WALLET_NOT_FOUND', `${label}: ${message}`);
    }
    if (/policy|denied|forbidden/i.test(message)) {
      throw owsError('OWS_POLICY_VIOLATION', `${label}: ${message}`);
    }
    throw owsError('OWS_FAMILY_PARTIAL', `${label}: ${message}`);
  }
}

/** Shell-out to the `ows` CLI binary (used for backup/restore/recover). */
async function withCli(label: string, args: string[], cliPath = 'ows', env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cliPath, args, {
      env: { ...process.env, ...(env ?? {}) },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const message = (err as Error & { stderr?: string }).stderr ?? (err as Error).message;
    if (/ENOENT|not found/i.test(message)) {
      throw owsError('OWS_CLI_NOT_AVAILABLE', `${label}: ${cliPath} not found on PATH`);
    }
    throw owsError('OWS_FAMILY_PARTIAL', `${label}: ${message}`);
  }
}

/** Common confirm-required guard for destructive operations. */
function requireConfirm(opName: string, confirm: unknown): void {
  if (confirm !== true) {
    throw owsError('OWS_CONFIRM_REQUIRED', `${opName} requires { confirm: true }`);
  }
}

// ─── Public namespace ────────────────────────────────────────────────────────

export const ows = {
  // ─── Creation ──────────────────────────────────────────────────────────────

  createWallet(opts: CreateWalletOpts): Promise<WalletDescriptor> {
    return withSdk('createWallet', async (sdk) => {
      const wallet = await sdk.createWallet({
        name: opts.name,
        chains: opts.chains,
        accountCount: 1,
        mnemonicStrength: opts.mnemonicStrength ?? 256,
        passphrase: opts.passphrase,
      });
      return toDescriptor(wallet);
    });
  },

  importMnemonic(opts: { name: string; chains: string[]; passphrase?: string }): Promise<WalletDescriptor> {
    // Mnemonic itself is read by the SDK from stdin; never passed in code.
    return withSdk('importMnemonic', async (sdk) => {
      const wallet = await sdk.importMnemonic({
        name: opts.name,
        chains: opts.chains,
        passphrase: opts.passphrase,
      });
      return toDescriptor(wallet);
    });
  },

  importPrivateKey(opts: { name: string; key: string; family: ChainFamily; passphrase?: string }): Promise<WalletDescriptor> {
    return withSdk('importPrivateKey', async (sdk) => {
      const wallet = await sdk.importPrivateKey(opts);
      return toDescriptor(wallet);
    });
  },

  importKeystore(opts: { name: string; file: string; password?: string; passphrase?: string }): Promise<WalletDescriptor> {
    return withSdk('importKeystore', async (sdk) => toDescriptor(await sdk.importKeystore(opts)));
  },

  importWif(opts: { name: string; key: string; passphrase?: string }): Promise<WalletDescriptor> {
    return withSdk('importWif', async (sdk) => toDescriptor(await sdk.importWif(opts)));
  },

  importSolanaKeypair(opts: { name: string; file: string; passphrase?: string }): Promise<WalletDescriptor> {
    return withSdk('importSolanaKeypair', async (sdk) => toDescriptor(await sdk.importSolanaKeypair(opts)));
  },

  importSuiKeystore(opts: { name: string; file: string; passphrase?: string }): Promise<WalletDescriptor> {
    return withSdk('importSuiKeystore', async (sdk) => toDescriptor(await sdk.importSuiKeystore(opts)));
  },

  // ─── Export ────────────────────────────────────────────────────────────────

  exportMnemonic(opts: { wallet: string; confirm: true }): Promise<string> {
    requireConfirm('exportMnemonic', opts.confirm);
    return withSdk('exportMnemonic', (sdk) => sdk.exportMnemonic(opts));
  },

  exportKeystore(opts: { wallet: string; account: string; output: string; password?: string }): Promise<void> {
    return withSdk('exportKeystore', (sdk) => sdk.exportKeystore(opts));
  },

  exportRaw(opts: { wallet: string; account: string; confirm: true }): Promise<string> {
    requireConfirm('exportRaw', opts.confirm);
    return withSdk('exportRaw', (sdk) => sdk.exportRaw(opts));
  },

  // ─── Backup / restore / auto-backup ────────────────────────────────────────

  async backupVault(opts: { output: string; passphraseEnv: string; cliPath?: string }): Promise<void> {
    const passphrase = process.env[opts.passphraseEnv];
    if (!passphrase) {
      throw owsError('OWS_CONFIRM_REQUIRED', `env var "${opts.passphraseEnv}" is empty; backup aborted`);
    }
    const sdk = await loadSdk();
    if (sdk?.backup) {
      await sdk.backup({ output: opts.output, passphrase });
      return;
    }
    // Fallback: shell out to `ows backup`. Pass the passphrase via env, never argv.
    await withCli('backupVault', ['backup', '--output', opts.output], opts.cliPath, {
      OWS_BACKUP_PASSPHRASE: passphrase,
    });
  },

  async restoreVault(opts: { input: string; passphraseEnv?: string; cliPath?: string }): Promise<void> {
    const passphrase = opts.passphraseEnv ? process.env[opts.passphraseEnv] : undefined;
    const sdk = await loadSdk();
    if (sdk?.restore && passphrase) {
      await sdk.restore({ input: opts.input, passphrase });
      return;
    }
    await withCli('restoreVault', ['restore', '--input', opts.input], opts.cliPath, passphrase ? { OWS_BACKUP_PASSPHRASE: passphrase } : undefined);
  },

  /**
   * Configure automated daily backup. Writes the snippet to ~/.ows/config.json
   * via the CLI; SDK doesn't expose this directly in v1.3.2.
   */
  async configureAutoBackup(opts: { schedule: 'daily' | 'weekly'; retention: number; destination?: string; cliPath?: string }): Promise<void> {
    const args = ['config', 'set', 'backup.enabled=true', `backup.schedule=${opts.schedule}`, `backup.retention=${opts.retention}`];
    if (opts.destination) args.push(`backup.destination=${opts.destination}`);
    await withCli('configureAutoBackup', args, opts.cliPath);
  },

  // ─── Recovery ──────────────────────────────────────────────────────────────

  recover(opts: { name: string; chains: string[]; gapLimit?: number }): Promise<WalletDescriptor> {
    // Mnemonic itself is read by the SDK from stdin; never passed in code.
    return withSdk('recover', async (sdk) =>
      toDescriptor(
        await sdk.recover({
          name: opts.name,
          chains: opts.chains,
          gapLimit: opts.gapLimit ?? 20,
        }),
      ),
    );
  },

  // ─── Active management ────────────────────────────────────────────────────

  lock(wallet: string): Promise<void> {
    return withSdk('lock', (sdk) => sdk.lock(wallet));
  },

  unlock(wallet: string, passphrase?: string): Promise<void> {
    return withSdk('unlock', (sdk) => sdk.unlock(wallet, passphrase));
  },

  rotate(opts: { from: string; to: string; chains: string[] }): Promise<void> {
    return withSdk('rotate', (sdk) => sdk.rotate(opts));
  },

  discover(opts: DiscoverOpts = {}): Promise<WalletDescriptor[]> {
    return withSdk('discover', async (sdk) => {
      const list = await Promise.resolve(
        sdk.listWallets({
          chainType: opts.chainType,
          namePattern: opts.namePattern,
          hasPolicy: opts.hasPolicy,
        }),
      );
      return list.map(toDescriptor);
    });
  },

  delete(opts: { wallet: string; confirm: true }): Promise<void> {
    requireConfirm('delete', opts.confirm);
    return withSdk('delete', (sdk) => sdk.deleteWallet(opts));
  },

  // ─── Policy CRUD ──────────────────────────────────────────────────────────

  async createPolicy(def: PolicyDef): Promise<PolicyId> {
    return withSdk('createPolicy', async (sdk) => {
      const created = await sdk.policy.create(def);
      return created.id;
    });
  },

  listPolicies(): Promise<PolicySummary[]> {
    return withSdk('listPolicies', async (sdk) => {
      const list = await sdk.policy.list();
      return list.map((p) => ({ id: p.id, allowChains: p.allowChains, expiry: p.expiry }));
    });
  },

  getPolicy(id: PolicyId): Promise<PolicyDef | null> {
    return withSdk('getPolicy', async (sdk) => {
      const p = await sdk.policy.get(id);
      if (!p) return null;
      return { allowChains: p.allowChains, expiry: p.expiry, customExec: p.customExec, maxValuePerTx: p.maxValuePerTx };
    });
  },

  deletePolicy(id: PolicyId): Promise<void> {
    return withSdk('deletePolicy', (sdk) => sdk.policy.delete(id));
  },

  // ─── API key CRUD ─────────────────────────────────────────────────────────

  /**
   * Create a scoped API key. The returned `token` is shown ONCE — caller must persist it
   * immediately. A lost token cannot be recovered, only revoked + reissued.
   */
  createApiKey(opts: ApiKeyOpts): Promise<ApiKeyIssued> {
    return withSdk('createApiKey', async (sdk) => {
      const issued = await sdk.apiKey.create(opts);
      return { id: issued.id, name: issued.name, token: issued.token, expires: issued.expires };
    });
  },

  listApiKeys(): Promise<ApiKeySummary[]> {
    return withSdk('listApiKeys', async (sdk) => {
      const list = await sdk.apiKey.list();
      return list.map((k) => ({ id: k.id, name: k.name, wallets: k.wallets, policy: k.policy, expires: k.expires }));
    });
  },

  revokeApiKey(id: ApiKeyId): Promise<void> {
    return withSdk('revokeApiKey', (sdk) => sdk.apiKey.revoke(id));
  },

  // ─── Mnemonic utilities ───────────────────────────────────────────────────

  generateMnemonic(opts: { words?: 12 | 24 } = {}): Promise<string> {
    return withSdk('generateMnemonic', (sdk) => sdk.mnemonic.generate({ words: opts.words ?? 24 }));
  },

  deriveAddress(opts: { mnemonic: string; chain: string; index?: number }): Promise<{ address: string; path: string }> {
    return withSdk('deriveAddress', (sdk) => sdk.mnemonic.derive(opts));
  },
};

// ─── Internal mapper ─────────────────────────────────────────────────────────

interface RawWallet {
  id?: string;
  name: string;
  accounts: { address: string; chainId: string; family?: string; derivationPath?: string }[];
  createdAt?: string;
}

function toDescriptor(w: RawWallet): WalletDescriptor {
  return {
    id: w.id ?? w.name,
    name: w.name,
    accounts: w.accounts.map((a) => ({
      address: a.address,
      chainId: a.chainId,
      family: (a.family as ChainFamily) ?? inferFamilyFromCaip2(a.chainId),
      derivationPath: a.derivationPath ?? '',
    })),
    createdAt: w.createdAt ?? new Date().toISOString(),
  };
}

function inferFamilyFromCaip2(caip2: string): ChainFamily {
  // Lazy-load to avoid circular import; only called inside toDescriptor.
  // Inline version of resolveFamily for descriptor mapping; full validation
  // happens at sign-time in OWSWallet/cli-driver.
  const namespace = caip2.split(':')[0] ?? '';
  const map: Record<string, ChainFamily> = {
    eip155: 'evm', solana: 'solana', bip122: 'bitcoin', cosmos: 'cosmos',
    tron: 'tron', ton: 'ton', sui: 'sui', xrpl: 'xrpl',
    spark: 'spark', fil: 'filecoin', near: 'near',
  };
  return map[namespace] ?? 'evm';
}
