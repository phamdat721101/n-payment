import { NPaymentError } from '../errors.js';
import type { XrplConnection } from './connection.js';
import type { XrplWallet } from './wallet.js';
import type { XrplVaultClient } from './vault.js';
import type { XrplTreasuryConfigInput } from '../types.js';
import { readAccountState } from './payments.js';
import {
  formatRlusdAmount,
  getRlusdIssuer,
  parseRlusdAmount,
  type XrplNetwork,
} from './utils.js';

// ─── VaultId persistence (Gstack Q1 fix) ─────────────────────────────────────

/**
 * Persistence contract for auto-provisioned vault IDs.
 * v0.14 ships memory-only; consumers can inject Redis/DB/file impls.
 */
export interface VaultIdStore {
  read(walletAddress: string): Promise<string | null>;
  write(walletAddress: string, vaultId: string): Promise<void>;
}

/**
 * In-process VaultIdStore. Vault ID is **ephemeral on restart**.
 * For production, inject a durable store (Redis, DB, file) via `treasury.store`.
 */
export class MemoryVaultIdStore implements VaultIdStore {
  private readonly store = new Map<string, string>();
  async read(addr: string): Promise<string | null> { return this.store.get(addr) ?? null; }
  async write(addr: string, id: string): Promise<void> { this.store.set(addr, id); }
}

// ─── Runtime config (extends the public input config) ────────────────────────

export interface XrplTreasuryConfig extends XrplTreasuryConfigInput {
  store?: VaultIdStore;
  /** Min drops the wallet must hold before VaultCreate (covers owner reserve). @default 5_000_000 */
  minXrpReserve?: bigint;
}

export interface XrplTreasuryDeps {
  connection: XrplConnection;
  wallet: XrplWallet;
  vault: XrplVaultClient;
  network: XrplNetwork;
}

export interface XrplTreasuryState {
  /** Decimal RLUSD held liquid in the main account. */
  liquid: string;
  /** Decimal RLUSD-equivalent held in the vault (totalAssets at last read). */
  supplied: string;
  /** Active vault ID (configured or auto-provisioned). */
  vaultId?: string;
  /** Wallet classic address. */
  address: string;
}

// ─── Manager (mirrors AaveTreasuryManager shape) ─────────────────────────────

const DEFAULT_MIN_IDLE = '10';            // 10 RLUSD
const DEFAULT_MIN_XRP_RESERVE = 5_000_000n; // 5 XRP in drops
const DEFAULT_SWEEP_DEBOUNCE_MS = 30_000;

export class XrplTreasuryManager {
  private readonly store: VaultIdStore;
  private readonly issuer: string;
  private readonly minIdleUnits: bigint;
  private readonly minXrpReserve: bigint;
  private readonly sweepDebounceMs: number;
  private cachedVaultId?: string;
  private sweepTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly config: XrplTreasuryConfig,
    private readonly deps: XrplTreasuryDeps,
  ) {
    this.store = config.store ?? new MemoryVaultIdStore();
    this.issuer = getRlusdIssuer(deps.network);
    this.minIdleUnits = parseRlusdAmount(config.minIdleBalance ?? DEFAULT_MIN_IDLE);
    this.minXrpReserve = config.minXrpReserve ?? DEFAULT_MIN_XRP_RESERVE;
    this.sweepDebounceMs = config.sweepDebounceMs ?? DEFAULT_SWEEP_DEBOUNCE_MS;
    if (config.vaultId) this.cachedVaultId = config.vaultId;
  }

  isEnabled(): boolean { return this.config.autoYield === true; }

  /**
   * Resolve the active vault ID, auto-provisioning when configured.
   * Throws XRPL_NO_VAULT if neither configured nor auto-provisionable.
   * Throws XRPL_INSUFFICIENT_XRP_RESERVE before VaultCreate to avoid cryptic rippled errors.
   */
  async ensureVault(): Promise<string> {
    if (this.cachedVaultId) return this.cachedVaultId;
    const address = await this.deps.wallet.getAddress();

    const stored = await this.store.read(address);
    if (stored) { this.cachedVaultId = stored; return stored; }

    if (!this.config.autoCreate) {
      throw new NPaymentError(
        'No vaultId configured and autoCreate disabled',
        'XRPL_NO_VAULT',
        'Pass xrpl.treasury.vaultId or xrpl.treasury.autoCreate: true.',
      );
    }

    // Reserve precheck (Gstack Q6).
    const state = await readAccountState(this.deps.connection, address, { issuer: this.issuer });
    if (state.xrpDrops < this.minXrpReserve) {
      throw new NPaymentError(
        `Insufficient XRP reserve to auto-provision vault: have ${state.xrpDrops} drops, need ≥ ${this.minXrpReserve}`,
        'XRPL_INSUFFICIENT_XRP_RESERVE',
        'Fund the wallet with at least 5 XRP, or pre-create the vault and pass xrpl.treasury.vaultId.',
      );
    }

    let vaultId: string;
    try {
      const created = await this.deps.vault.createVault({ scale: 6 });
      vaultId = created.vaultId;
    } catch (err) {
      throw new NPaymentError(
        `Vault auto-provision failed: ${(err as Error).message}`,
        'XRPL_VAULT_AUTO_PROVISION_FAILED',
        'Inspect rippled logs; XLS-65 may not be enabled on this network.',
      );
    }
    await this.store.write(address, vaultId);
    this.cachedVaultId = vaultId;
    if (this.store instanceof MemoryVaultIdStore) {
      console.warn(
        `[n-payment][xrpl] Auto-provisioned vault ${vaultId} stored in memory only. ` +
        'Inject a durable VaultIdStore via xrpl.treasury.store to avoid orphan vaults on restart.',
      );
    }
    return vaultId;
  }

  /** Withdraw from vault if liquid balance < amount. No-op when sufficient. */
  async ensureLiquid(amountRlusd: string): Promise<void> {
    const need = parseRlusdAmount(amountRlusd);
    const address = await this.deps.wallet.getAddress();
    const state = await readAccountState(this.deps.connection, address, { issuer: this.issuer });
    const liquid = parseRlusdAmount(state.rlusdBalance);
    if (liquid >= need) return;

    const vaultId = await this.ensureVault();
    const shortfall = need - liquid;
    await this.deps.vault.withdraw(vaultId, { amount: formatRlusdAmount(shortfall) });
  }

  /**
   * Schedule a debounced sweep. Coalesces rapid-fire calls into a single
   * VaultDeposit per `sweepDebounceMs` window (Gstack P4).
   */
  scheduleSweep(): void {
    if (!this.isEnabled()) return;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      // Best-effort — never throw upstream.
      void this.sweepExcess().catch((e) =>
        console.warn('[n-payment][xrpl] sweep failed:', (e as Error)?.message),
      );
    }, this.sweepDebounceMs);
    // Don't keep the event loop alive solely for a sweep timer.
    if (typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  /** Deposit any RLUSD above `minIdleBalance` into the vault. */
  async sweepExcess(): Promise<void> {
    if (!this.isEnabled()) return;
    const address = await this.deps.wallet.getAddress();
    const state = await readAccountState(this.deps.connection, address, { issuer: this.issuer, fresh: true });
    const liquid = parseRlusdAmount(state.rlusdBalance);
    if (liquid <= this.minIdleUnits) return;
    const vaultId = await this.ensureVault();
    const excess = liquid - this.minIdleUnits;
    await this.deps.vault.deposit(vaultId, formatRlusdAmount(excess));
  }

  async getState(): Promise<XrplTreasuryState> {
    const address = await this.deps.wallet.getAddress();
    const account = await readAccountState(this.deps.connection, address, { issuer: this.issuer });
    let supplied = '0';
    let vaultId = this.cachedVaultId ?? (await this.store.read(address)) ?? undefined;
    if (vaultId) {
      try {
        const info = await this.deps.vault.getVaultInfo(vaultId);
        supplied = info.totalAssets;
      } catch { /* vault may not exist on chain yet — best-effort */ }
    }
    return { liquid: account.rlusdBalance, supplied, vaultId, address };
  }
}
