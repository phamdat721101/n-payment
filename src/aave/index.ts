import type { AaveConfig } from '../types.js';
import { AaveClient } from './client.js';
import { YieldManager } from './yield.js';
import { GhoManager } from './gho.js';
import { VaultManager } from './vault.js';
import { FlashMintBatcher } from './flash.js';
import { DelegationBridge } from './delegation.js';

/**
 * Top-level orchestrator for all Aave treasury operations.
 * Used by PaymentClient to manage yield, GHO, vaults, flash loans, and delegation.
 */
export class AaveTreasuryManager {
  readonly client: AaveClient;
  readonly yield: YieldManager;
  readonly gho: GhoManager;
  readonly vault: VaultManager | undefined;
  readonly flash: FlashMintBatcher;
  readonly delegation: DelegationBridge;

  constructor(private config: AaveConfig, chainKey: string) {
    this.client = new AaveClient(chainKey);
    this.yield = new YieldManager(config, chainKey);
    this.gho = new GhoManager(config, chainKey);
    this.vault = config.vault?.enabled
      ? new VaultManager({ enabled: true, feePercent: config.vault.feePercent ?? 15 })
      : undefined;
    this.flash = new FlashMintBatcher(this.gho);
    this.delegation = new DelegationBridge(config);
  }

  /** Determine how to fund a payment: liquid balance, withdraw from Aave, or borrow GHO */
  decideFundingStrategy(liquidBalance: bigint, paymentAmount: bigint, ghoAccepted: boolean): 'liquid' | 'withdraw' | 'borrow-gho' {
    if (liquidBalance >= paymentAmount) return 'liquid';
    if (this.config.preferGho && this.config.borrowEnabled && ghoAccepted && this.gho.isAvailable()) return 'borrow-gho';
    if (this.yield.isEnabled()) return 'withdraw';
    return 'liquid'; // will fail at payment time if insufficient
  }

  /** Check if auto-sweep should run after a payment */
  shouldSweep(liquidBalance: bigint): boolean {
    if (!this.yield.isEnabled()) return false;
    return this.yield.calculateSweepAmount(liquidBalance) > 0n;
  }

  isEnabled(): boolean { return !!this.config && this.client.isSupported(); }
}

// ─── Barrel Export ───────────────────────────────────────────────────────────

export { AaveClient, GHO_ADDRESSES, AAVE_POOL_ADDRESSES, GHO_FLASH_MINTER } from './client.js';
export { YieldManager } from './yield.js';
export { GhoManager } from './gho.js';
export { VaultManager } from './vault.js';
export { FlashMintBatcher } from './flash.js';
export { DelegationBridge } from './delegation.js';
export type { YieldState } from './yield.js';
export type { VaultConfig, VaultState } from './vault.js';
export type { FlashPayment, FlashBatchResult } from './flash.js';
export type { Delegation } from './delegation.js';
