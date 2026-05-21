import type { Address } from 'viem';
import type { AaveConfig } from '../types.js';
import { AaveClient, AAVE_POOL_ADDRESSES } from './client.js';
import { NPaymentError } from '../errors.js';

// Aave V3 Pool ABI (minimal — supply/withdraw only)
const POOL_ABI = [
  { name: 'supply', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'onBehalfOf', type: 'address' }, { name: 'referralCode', type: 'uint16' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'asset', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface YieldState {
  supplied: bigint;
  yieldEarned: bigint;
  lastSweepAt: number;
}

export class YieldManager {
  private state: YieldState = { supplied: 0n, yieldEarned: 0n, lastSweepAt: 0 };
  private client: AaveClient;
  private minIdle: bigint;

  constructor(private config: AaveConfig, chainKey: string) {
    this.client = new AaveClient(chainKey);
    this.minIdle = config.minIdleBalance ?? 10_000000n; // default $10 USDC
  }

  /** Build supply tx data for Aave Pool */
  buildSupplyTx(asset: Address, amount: bigint, onBehalfOf: Address) {
    const pool = this.client.getPoolAddress();
    if (!pool) throw new NPaymentError('Aave not supported on this chain', 'AAVE_UNSUPPORTED');
    return { to: pool, abi: POOL_ABI, functionName: 'supply' as const, args: [asset, amount, onBehalfOf, 0] };
  }

  /** Build withdraw tx data from Aave Pool */
  buildWithdrawTx(asset: Address, amount: bigint, to: Address) {
    const pool = this.client.getPoolAddress();
    if (!pool) throw new NPaymentError('Aave not supported on this chain', 'AAVE_UNSUPPORTED');
    return { to: pool, abi: POOL_ABI, functionName: 'withdraw' as const, args: [asset, amount, to] };
  }

  /** Calculate how much to sweep into Aave (balance - minIdle) */
  calculateSweepAmount(currentBalance: bigint): bigint {
    if (currentBalance <= this.minIdle) return 0n;
    return currentBalance - this.minIdle;
  }

  /** Calculate how much to withdraw for a payment */
  calculateWithdrawAmount(currentBalance: bigint, paymentAmount: bigint): bigint {
    if (currentBalance >= paymentAmount) return 0n;
    return paymentAmount - currentBalance;
  }

  recordSupply(amount: bigint): void {
    this.state.supplied += amount;
    this.state.lastSweepAt = Date.now();
  }

  recordWithdraw(amount: bigint): void {
    this.state.supplied = this.state.supplied > amount ? this.state.supplied - amount : 0n;
  }

  getState(): YieldState { return { ...this.state }; }
  isEnabled(): boolean { return this.config.autoYield === true && this.client.isSupported(); }
}
