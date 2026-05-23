import type { Address } from 'viem';
import { NPaymentError } from '../errors.js';
import { assetManagerAbi } from './abis.js';
import type { FlareClient } from './client.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** XRP scale: 1 XRP = 1,000,000 drops (and 1 UBA, since FXRP mirrors XRP drops). */
export const XRP_SCALE = 1_000_000n;
const BIPS_DENOMINATOR = 10_000n;

/** 32-byte memo magic for the recipient-only direct-minting memo: bytes "FBPRfA" + 0x0018. */
export const DIRECT_MINTING_MEMO_PREFIX = '4642505266410018';

// ─── Amount validation (strict, BigInt-based) ────────────────────────────────

/**
 * Parse a decimal XRP amount string into UBA / drops (6-decimal bigint).
 * Rejects scientific notation, NaN, negatives, zero, and over-precision.
 *
 * @example parseXrpDropsAmount("10")        → 10_000_000n
 * @example parseXrpDropsAmount("10.123456") → 10_123_456n
 */
export function parseXrpDropsAmount(input: string): bigint {
  if (typeof input !== 'string' || !/^[0-9]+(\.[0-9]{1,6})?$/.test(input)) {
    throw new NPaymentError(
      `Invalid XRP amount: ${JSON.stringify(input)}`,
      'FLARE_INVALID_AMOUNT',
      'Use plain decimal notation up to 6 places, e.g. "10.123456".',
    );
  }
  const [int, frac = ''] = input.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const units = BigInt(int) * XRP_SCALE + BigInt(fracPadded);
  if (units === 0n) {
    throw new NPaymentError('XRP amount must be > 0', 'FLARE_INVALID_AMOUNT');
  }
  return units;
}

/** Format 6-decimal UBA back to a decimal XRP string. Trailing zeros trimmed. */
export function formatXrpDropsAmount(units: bigint): string {
  if (units < 0n) {
    throw new NPaymentError('Negative XRP amount', 'FLARE_INVALID_AMOUNT');
  }
  const int = units / XRP_SCALE;
  const frac = units % XRP_SCALE;
  if (frac === 0n) return int.toString();
  return `${int}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}

// ─── Fee maths (pure) ────────────────────────────────────────────────────────

export interface DirectMintingFees {
  /** Proportional fee in BIPS (1/10_000). */
  feeBips: bigint;
  /** Minimum minting fee floor (UBA). */
  minFeeUBA: bigint;
  /** Flat executor fee (UBA). */
  executorFeeUBA: bigint;
}

export interface DirectMintingQuote {
  netMintUBA: bigint;
  proportionalFeeUBA: bigint;
  mintingFeeUBA: bigint;
  executorFeeUBA: bigint;
  totalUBA: bigint;
  paymentXrp: string;
  netFxrp: string;
}

/**
 * Compute the gross XRP payment required to mint `netMintAmountXrp` XRP-worth of FXRP,
 * accounting for the proportional minting fee + minimum floor + flat executor fee.
 * Pure function — no I/O. Mirrors the maths from the Flare cross-chain-mint guide.
 */
export function computeDirectMintingQuote(
  netMintAmountXrp: string,
  fees: DirectMintingFees,
): DirectMintingQuote {
  const netMintUBA = parseXrpDropsAmount(netMintAmountXrp);
  const proportionalFeeUBA = (netMintUBA * fees.feeBips) / BIPS_DENOMINATOR;
  const mintingFeeUBA = proportionalFeeUBA > fees.minFeeUBA ? proportionalFeeUBA : fees.minFeeUBA;
  const totalUBA = netMintUBA + mintingFeeUBA + fees.executorFeeUBA;
  return {
    netMintUBA,
    proportionalFeeUBA,
    mintingFeeUBA,
    executorFeeUBA: fees.executorFeeUBA,
    totalUBA,
    paymentXrp: formatXrpDropsAmount(totalUBA),
    netFxrp: formatXrpDropsAmount(netMintUBA),
  };
}

// ─── On-chain reads (Core Vault address + fees + threshold) ──────────────────

/** Resolve the Core Vault XRPL address — destination for every direct-minting Payment. */
export async function getDirectMintingPaymentAddress(client: FlareClient): Promise<string> {
  const assetManager = await client.registry.address('AssetManagerFXRP');
  try {
    return (await client.publicClient.readContract({
      address: assetManager,
      abi: assetManagerAbi,
      functionName: 'directMintingPaymentAddress',
    })) as string;
  } catch (err) {
    throw new NPaymentError(
      `Failed to resolve Core Vault XRPL address: ${(err as Error).message}`,
      'FLARE_CORE_VAULT_RESOLUTION_FAILED',
      'Verify the Coston2 RPC is reachable and the AssetManagerFXRP is registered.',
    );
  }
}

/** Read the live direct-minting fee parameters from AssetManagerFXRP, in parallel. */
export async function getDirectMintingFees(client: FlareClient): Promise<DirectMintingFees> {
  const assetManager = await client.registry.address('AssetManagerFXRP');
  try {
    const [feeBips, minFeeUBA, executorFeeUBA] = await Promise.all([
      client.publicClient.readContract({
        address: assetManager,
        abi: assetManagerAbi,
        functionName: 'getDirectMintingFeeBIPS',
      }),
      client.publicClient.readContract({
        address: assetManager,
        abi: assetManagerAbi,
        functionName: 'getDirectMintingMinimumFeeUBA',
      }),
      client.publicClient.readContract({
        address: assetManager,
        abi: assetManagerAbi,
        functionName: 'getDirectMintingExecutorFeeUBA',
      }),
    ]);
    return {
      feeBips: feeBips as bigint,
      minFeeUBA: minFeeUBA as bigint,
      executorFeeUBA: executorFeeUBA as bigint,
    };
  } catch (err) {
    throw new NPaymentError(
      `Failed to read direct-minting fees: ${(err as Error).message}`,
      'FLARE_FEE_READ_FAILED',
      'Verify the Coston2 RPC is reachable and the AssetManagerFXRP is up to date.',
    );
  }
}

export interface DirectMintingPreflight {
  /** True iff the totalUBA is above the protocol's "large minting" threshold (will be delayed). */
  large: boolean;
  /** Threshold read from chain, or null if the protocol does not expose one. */
  largeThresholdUBA: bigint | null;
}

/**
 * Best-effort large-minting preflight. The Flare protocol *throttles* rather than
 * rejects above the threshold, so we surface a structured warning and never throw.
 * On any read error (e.g. function not exposed), returns `{ large: false, largeThresholdUBA: null }`.
 */
export async function preflightDirectMintingLimits(
  client: FlareClient,
  totalUBA: bigint,
): Promise<DirectMintingPreflight> {
  try {
    const assetManager = await client.registry.address('AssetManagerFXRP');
    const threshold = (await client.publicClient.readContract({
      address: assetManager,
      abi: assetManagerAbi,
      functionName: 'getDirectMintingLargeMintingThresholdUBA',
    })) as bigint;
    return { large: totalUBA >= threshold, largeThresholdUBA: threshold };
  } catch {
    return { large: false, largeThresholdUBA: null };
  }
}

// ─── 32-byte memo encoder (golden-vectored, pure) ────────────────────────────

/**
 * Encode the 32-byte direct-minting memo:
 *   [8 bytes 0x4642505266410018][4 bytes 0x00000000][20 bytes recipient]
 *
 * Output is a 32-byte Uint8Array. Use {@link toXrplMemoHex} to render the
 * uppercase hex required by XRPL `Memos[].Memo.MemoData`.
 */
export function encodeDirectMintingMemo32(recipient: Address): Uint8Array {
  if (typeof recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new NPaymentError(
      `Invalid Flare recipient address: ${JSON.stringify(recipient)}`,
      'FLARE_INVALID_ADDRESS',
      'Recipient must be a 0x-prefixed 20-byte hex string (PersonalAccount address).',
    );
  }
  const bytes = new Uint8Array(32);
  // Prefix.
  for (let i = 0; i < 8; i++) {
    bytes[i] = parseInt(DIRECT_MINTING_MEMO_PREFIX.slice(i * 2, i * 2 + 2), 16);
  }
  // 4 bytes already zeroed.
  // Recipient (lowercased to canonicalise).
  const hex = recipient.slice(2).toLowerCase();
  for (let i = 0; i < 20; i++) {
    bytes[12 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Render bytes as the uppercase hex string XRPL expects in `Memo.MemoData`. */
export function toXrplMemoHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out.toUpperCase();
}
