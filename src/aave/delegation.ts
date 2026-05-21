import type { Address } from 'viem';
import type { AaveConfig } from '../types.js';
import { NPaymentError } from '../errors.js';

// Aave V3 variable debt token ABI (credit delegation)
const DEBT_TOKEN_ABI = [
  { name: 'approveDelegation', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'delegatee', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'borrowAllowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'fromUser', type: 'address' }, { name: 'toUser', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface Delegation {
  delegate: Address;
  asset: string;
  maxAmount: bigint;
  used: bigint;
}

/**
 * Bridges n-payment's DelegationManager with Aave's on-chain credit delegation.
 * Parent agent supplies collateral → delegates borrowing power to sub-agents.
 */
export class DelegationBridge {
  private delegations = new Map<string, Delegation>();

  constructor(private config: AaveConfig) {}

  /** Build approveDelegation tx on the debt token */
  buildDelegateTx(debtToken: Address, delegatee: Address, amount: bigint) {
    return { to: debtToken, abi: DEBT_TOKEN_ABI, functionName: 'approveDelegation' as const, args: [delegatee, amount] };
  }

  /** Build revoke tx (set allowance to 0) */
  buildRevokeTx(debtToken: Address, delegatee: Address) {
    return this.buildDelegateTx(debtToken, delegatee, 0n);
  }

  /** Track a delegation locally */
  addDelegation(delegate: Address, asset: string, maxAmount: bigint): void {
    const maxPerDelegate = this.config.delegation?.maxPerDelegate;
    if (maxPerDelegate && maxAmount > maxPerDelegate) {
      throw new NPaymentError(`Delegation exceeds maxPerDelegate: ${maxPerDelegate}`, 'DELEGATION_LIMIT');
    }
    this.delegations.set(`${delegate}-${asset}`, { delegate, asset, maxAmount, used: 0n });
  }

  /** Record usage by a delegate */
  recordUsage(delegate: Address, asset: string, amount: bigint): void {
    const key = `${delegate}-${asset}`;
    const d = this.delegations.get(key);
    if (!d) throw new NPaymentError('No delegation found', 'DELEGATION_NOT_FOUND');
    if (d.used + amount > d.maxAmount) throw new NPaymentError('Delegation limit exceeded', 'DELEGATION_EXCEEDED');
    d.used += amount;
  }

  getDelegations(): Delegation[] { return [...this.delegations.values()]; }
  getDebtTokenAbi() { return DEBT_TOKEN_ABI; }
  isEnabled(): boolean { return this.config.delegation?.enabled === true; }
}
