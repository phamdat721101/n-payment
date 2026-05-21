import type { Address } from 'viem';
import type { AaveConfig } from '../types.js';
import { AaveClient, GHO_ADDRESSES, GHO_FLASH_MINTER } from './client.js';
import { NPaymentError } from '../errors.js';

// GHO EIP-2612 permit domain
const GHO_PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

// Minimal GHO ABI
const GHO_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'nonces', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

// Flash Minter ABI
const FLASH_MINTER_ABI = [
  { name: 'flashLoan', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'receiver', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [{ type: 'bool' }] },
  { name: 'maxFlashLoan', type: 'function', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'getFee', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export class GhoManager {
  private client: AaveClient;

  constructor(private config: AaveConfig, private chainKey: string) {
    this.client = new AaveClient(chainKey);
  }

  getGhoAddress(): Address {
    const addr = this.client.getGhoAddress();
    if (!addr) throw new NPaymentError(`GHO not available on ${this.chainKey}`, 'GHO_UNSUPPORTED');
    return addr;
  }

  /** Build EIP-2612 permit typed data for gasless GHO approval */
  buildPermitTypedData(owner: Address, spender: Address, value: bigint, nonce: bigint, deadline: bigint, chainId: number) {
    return {
      domain: { name: 'Gho Token', version: '1', chainId, verifyingContract: this.getGhoAddress() },
      types: GHO_PERMIT_TYPES,
      primaryType: 'Permit' as const,
      message: { owner, spender, value, nonce, deadline },
    };
  }

  /** Build GHO transfer tx */
  buildTransferTx(to: Address, amount: bigint) {
    return { to: this.getGhoAddress(), abi: GHO_ABI, functionName: 'transfer' as const, args: [to, amount] };
  }

  /** Get flash minter address (Ethereum only) */
  getFlashMinterAddress(): Address | undefined {
    return GHO_FLASH_MINTER[this.chainKey];
  }

  getFlashMinterAbi() { return FLASH_MINTER_ABI; }
  getGhoAbi() { return GHO_ABI; }
  isAvailable(): boolean { return !!this.client.getGhoAddress(); }
  preferGho(): boolean { return this.config.preferGho === true && this.isAvailable(); }
}
