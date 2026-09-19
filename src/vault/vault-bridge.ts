/**
 * v0.31 — VaultPaymentBridge: PayRouter <-> AutonomousDeFiAllocationVault
 * TS bridge (Task 15).
 *
 * Design constraint (matches this repo's universal convention, seen in
 * client.ts's `if (config.aave) { ... }` pattern for every other optional
 * integration): this bridge is OPT-IN via an absent-by-default config
 * object. When no vault config is supplied, `fetchWithPayment()` callers
 * must see IDENTICAL behavior to today — this module never silently
 * changes settlement behavior for callers who haven't configured a vault.
 *
 * Scope: this is a standalone bridge module proven correct in isolation
 * (see tests/vault-bridge.test.ts). Wiring it into the giant PaymentClient
 * (src/client.ts) as a new `config.vault` block is a separate, larger
 * integration surface explicitly deferred — this task's deliverable is the
 * bridge itself and proof that its opt-in/no-op contract holds.
 */
import type { PublicClient, WalletClient, Address } from 'viem';

export interface VaultBridgeConfig {
  vaultAddress: Address;
  client: PublicClient;
  wallet: WalletClient;
}

export type SettlementSourceDecision =
  | { source: 'direct-wallet' }
  | { source: 'vault'; vaultAddress: Address };

const INSTANT_WITHDRAW_ABI = [
  {
    type: 'function',
    name: 'instantWithdrawForPayment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export class VaultPaymentBridge {
  constructor(private readonly config: VaultBridgeConfig | undefined) {}

  /**
   * Pure decision function — no side effects. Used by callers (e.g. a
   * future PaymentClient integration) to decide whether a payment should
   * be settled directly from the agent's own wallet balance (today's
   * behavior, always available) or routed through the configured vault's
   * instant-unbonding waterfall.
   */
  public async resolveSettlementSource(_amountWei: bigint): Promise<SettlementSourceDecision> {
    if (!this.config) {
      return { source: 'direct-wallet' };
    }
    return { source: 'vault', vaultAddress: this.config.vaultAddress };
  }

  /**
   * Calls the real `instantWithdrawForPayment(amount, recipient)` ABI
   * function on the configured AutonomousDeFiAllocationVault (Task 14).
   * Throws a clear, typed error if no vault is configured — this method
   * is only ever reached after a caller has already checked
   * `resolveSettlementSource()` returned `{ source: 'vault' }`, so silently
   * no-op'ing here would hide a real caller-side logic error rather than
   * surfacing it.
   */
  public async executeUnbondedPayment(amountWei: bigint, recipient: Address): Promise<`0x${string}`> {
    if (!this.config) {
      throw new Error('VaultPaymentBridge.executeUnbondedPayment() called but no vault is configured — call resolveSettlementSource() first.');
    }

    const txHash = await this.config.wallet.writeContract({
      address: this.config.vaultAddress,
      abi: INSTANT_WITHDRAW_ABI,
      functionName: 'instantWithdrawForPayment',
      args: [amountWei, recipient],
    } as any);

    return txHash as `0x${string}`;
  }
}
