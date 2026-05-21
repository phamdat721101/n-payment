import type { Address } from 'viem';
import { NPaymentError } from '../errors.js';

// ERC-4626 minimal ABI
const VAULT_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'assets', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'totalAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'convertToShares', type: 'function', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { name: 'convertToAssets', type: 'function', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface VaultConfig {
  enabled: boolean;
  feePercent: number; // >= 10 (Aave requirement)
}

export interface VaultState {
  address?: Address;
  totalDeposited: bigint;
  feesCollected: bigint;
}

export class VaultManager {
  private state: VaultState = { totalDeposited: 0n, feesCollected: 0n };

  constructor(private config: VaultConfig) {
    if (config.feePercent < 10) {
      throw new NPaymentError('Vault fee must be >= 10% (Aave requirement)', 'VAULT_INVALID_FEE');
    }
  }

  /** Build deposit tx for ERC-4626 vault */
  buildDepositTx(vault: Address, assets: bigint, receiver: Address) {
    return { to: vault, abi: VAULT_ABI, functionName: 'deposit' as const, args: [assets, receiver] };
  }

  /** Build withdraw tx from ERC-4626 vault */
  buildWithdrawTx(vault: Address, assets: bigint, receiver: Address, owner: Address) {
    return { to: vault, abi: VAULT_ABI, functionName: 'withdraw' as const, args: [assets, receiver, owner] };
  }

  recordDeposit(amount: bigint): void { this.state.totalDeposited += amount; }
  recordWithdraw(amount: bigint): void { this.state.totalDeposited -= amount; }
  recordFee(amount: bigint): void { this.state.feesCollected += amount; }

  setVaultAddress(addr: Address): void { this.state.address = addr; }
  getState(): VaultState { return { ...this.state }; }
  getVaultAbi() { return VAULT_ABI; }
  isEnabled(): boolean { return this.config.enabled; }
}
