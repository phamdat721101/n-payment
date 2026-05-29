/**
 * EIP-3009 transferWithAuthorization helpers — Circle FiatTokenV2 standard.
 *
 * Pure functions, zero I/O. Shared by:
 *   - MorphX402Adapter (sponsored payment branch — signs typed data)
 *   - MorphHoodiFacilitator (verifies signature, submits on-chain)
 *
 * Spec: https://eips.ethereum.org/EIPS/eip-3009
 */
import { hexToBigInt, type Address, type Hex, type TypedDataDomain } from 'viem';

/** EIP-712 type definition for TransferWithAuthorization. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Wire-shape of the authorization payload (string-encoded for JSON transport). */
export interface AuthorizationPayload {
  from: Address;
  to: Address;
  value: string;        // base-10 string (uint256)
  validAfter: string;   // base-10 string (uint256)
  validBefore: string;  // base-10 string (uint256)
  nonce: Hex;           // 0x + 64 hex
}

export interface BuildTypedDataInput {
  /** USDC contract on Hoodi (0x7433…b661B). */
  verifyingContract: Address;
  chainId: number;
  /** USDC token name (Circle FiatTokenV2 default: "USD Coin"). Override per-deploy. */
  tokenName?: string;
  /** EIP-712 domain version (Circle default: "2"). */
  tokenVersion?: string;
  authorization: TransferAuthorization;
}

export interface SignableTypedData {
  domain: TypedDataDomain;
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: 'TransferWithAuthorization';
  message: TransferAuthorization;
}

/** Build the EIP-712 typed-data payload for `transferWithAuthorization`. */
export function buildTransferWithAuthorizationTypedData(input: BuildTypedDataInput): SignableTypedData {
  return {
    domain: {
      name: input.tokenName ?? 'USD Coin',
      version: input.tokenVersion ?? '2',
      chainId: input.chainId,
      verifyingContract: input.verifyingContract,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: input.authorization,
  };
}

/** Generate a cryptographically random 32-byte nonce (`0x` + 64 hex). */
export function randomEip3009Nonce(): Hex {
  // 32 random bytes via crypto.getRandomValues (Node 18+ ships globalThis.crypto)
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

/** Encode an authorization to a JSON-safe wire shape. */
export function encodeAuthorizationPayload(auth: TransferAuthorization): AuthorizationPayload {
  return {
    from: auth.from,
    to: auth.to,
    value: auth.value.toString(),
    validAfter: auth.validAfter.toString(),
    validBefore: auth.validBefore.toString(),
    nonce: auth.nonce,
  };
}

/** Decode a wire-shape authorization back to bigint-typed form. Throws on malformed input. */
export function decodeAuthorizationPayload(payload: unknown): TransferAuthorization {
  if (!payload || typeof payload !== 'object') throw new Error('authorization payload must be an object');
  const p = payload as Record<string, unknown>;
  for (const k of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof p[k] !== 'string') throw new Error(`authorization.${k} must be a string`);
  }
  return {
    from: p.from as Address,
    to: p.to as Address,
    value: BigInt(p.value as string),
    validAfter: BigInt(p.validAfter as string),
    validBefore: BigInt(p.validBefore as string),
    nonce: p.nonce as Hex,
  };
}

/**
 * Split a 65-byte 0x… signature into its v/r/s components for the
 * `transferWithAuthorization(from,to,value,validAfter,validBefore,nonce,v,r,s)` ABI.
 */
export function splitSignature(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (signature.length !== 132) throw new Error(`expected 65-byte signature, got ${(signature.length - 2) / 2} bytes`);
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const v = Number(hexToBigInt(`0x${signature.slice(130, 132)}` as Hex));
  return { v, r, s };
}

/** Minimal EIP-3009 ABI fragment used by both client (estimateGas) and facilitator (writeContract + read). */
export const EIP3009_ABI = [
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'authorizationState',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'authorizer', type: 'address' },
      { name: 'nonce', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
