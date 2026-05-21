import type { Address } from 'viem';
import { NPaymentError } from '../errors.js';
import { GhoManager } from './gho.js';

export interface FlashPayment {
  recipient: Address;
  amount: bigint;
}

export interface FlashBatchResult {
  totalAmount: bigint;
  paymentCount: number;
  txData: { to: Address; abi: readonly any[]; functionName: string; args: readonly any[] };
}

/**
 * Batches multiple GHO payments into a single GHO Flash Mint transaction.
 * Flash Mint: borrow GHO → distribute → repay in same tx (zero capital needed).
 */
export class FlashMintBatcher {
  private pending: FlashPayment[] = [];

  constructor(private ghoManager: GhoManager) {}

  addPayment(recipient: Address, amount: bigint): void {
    if (amount <= 0n) throw new NPaymentError('Payment amount must be > 0', 'FLASH_INVALID_AMOUNT');
    this.pending.push({ recipient, amount });
  }

  getPendingCount(): number { return this.pending.length; }
  getPendingTotal(): bigint { return this.pending.reduce((sum, p) => sum + p.amount, 0n); }

  /** Build flash mint tx that settles all pending payments atomically */
  buildBatchTx(receiverContract: Address): FlashBatchResult {
    if (!this.pending.length) throw new NPaymentError('No pending payments to batch', 'FLASH_EMPTY');
    const flashMinter = this.ghoManager.getFlashMinterAddress();
    if (!flashMinter) throw new NPaymentError('GHO Flash Minter not available on this chain', 'FLASH_UNSUPPORTED');

    const total = this.getPendingTotal();
    const ghoAddr = this.ghoManager.getGhoAddress();
    // Encode payments as calldata for the receiver contract
    const data = this.encodePayments();

    const result: FlashBatchResult = {
      totalAmount: total,
      paymentCount: this.pending.length,
      txData: {
        to: flashMinter,
        abi: this.ghoManager.getFlashMinterAbi(),
        functionName: 'flashLoan',
        args: [receiverContract, ghoAddr, total, data],
      },
    };

    this.pending = [];
    return result;
  }

  /** Encode pending payments as ABI-encoded bytes */
  private encodePayments(): `0x${string}` {
    // Simple encoding: concat (address, uint256) pairs
    const parts = this.pending.map(p =>
      p.recipient.slice(2).padStart(64, '0') + p.amount.toString(16).padStart(64, '0')
    );
    return `0x${parts.join('')}`;
  }

  clear(): void { this.pending = []; }
}
