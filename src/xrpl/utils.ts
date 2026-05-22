import { NPaymentError } from '../errors.js';

// ─── RLUSD Issuer Registry (single source of truth) ──────────────────────────

export type XrplNetwork = 'mainnet' | 'testnet';

/**
 * Per-network RLUSD issuer addresses.
 * Source: https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl
 * @default mainnet
 */
export const RLUSD_ISSUERS: Readonly<Record<XrplNetwork, string>> = Object.freeze({
  mainnet: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De',
  testnet: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
});

export const RLUSD_CURRENCY = 'RLUSD' as const;
/** RLUSD has 6 decimal places on XRPL (matches XRP drops scale). */
export const RLUSD_DECIMALS = 6 as const;
const RLUSD_SCALE = 1_000_000n; // 10 ** RLUSD_DECIMALS

/** Resolve the RLUSD issuer for a given XRPL network. */
export function getRlusdIssuer(network: XrplNetwork): string {
  return RLUSD_ISSUERS[network];
}

/** Map a chain key to an XRPL network. Returns 'testnet' for unknown keys (safer default). */
export function networkFromChainKey(chainKey: string): XrplNetwork {
  return chainKey === 'xrpl-mainnet' ? 'mainnet' : 'testnet';
}

// ─── RLUSD Amount Parsing (strict, no scientific notation) ───────────────────

/**
 * Parse a decimal RLUSD amount string into 6-decimal micro-units (bigint).
 * Rejects scientific notation, NaN, negatives, and over-precision (> 6 decimals).
 *
 * @example parseRlusdAmount("5.123456") → 5123456n
 * @example parseRlusdAmount("0.000001") → 1n
 */
export function parseRlusdAmount(input: string): bigint {
  if (typeof input !== 'string' || !/^[0-9]+(\.[0-9]{1,6})?$/.test(input)) {
    throw new NPaymentError(
      `Invalid RLUSD amount: ${JSON.stringify(input)}`,
      'XRPL_INVALID_AMOUNT',
      'Use plain decimal notation up to 6 places, e.g. "5.123456".',
    );
  }
  const [int, frac = ''] = input.split('.');
  const fracPadded = (frac + '000000').slice(0, RLUSD_DECIMALS);
  return BigInt(int) * RLUSD_SCALE + BigInt(fracPadded);
}

/** Format 6-decimal micro-units back to a decimal string. Trailing zeros trimmed. */
export function formatRlusdAmount(units: bigint): string {
  if (units < 0n) throw new NPaymentError('Negative RLUSD amount', 'XRPL_INVALID_AMOUNT');
  const int = units / RLUSD_SCALE;
  const frac = units % RLUSD_SCALE;
  if (frac === 0n) return int.toString();
  const fracStr = frac.toString().padStart(RLUSD_DECIMALS, '0').replace(/0+$/, '');
  return `${int}.${fracStr}`;
}

// ─── Slippage Math (pure) ────────────────────────────────────────────────────

const MAX_SLIPPAGE_BPS = 5000; // 50%

function assertSlippageBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new NPaymentError(
      `Invalid slippage: ${bps} bps`,
      'XRPL_INVALID_SLIPPAGE',
      `Slippage must be an integer between 0 and ${MAX_SLIPPAGE_BPS} bps.`,
    );
  }
}

/**
 * Pad a quote's source-amount-drops by the given slippage (basis points).
 * Always rounds **up** so we never under-fund the swap.
 */
export function padSendMaxDrops(quoteSourceDrops: bigint, slippageBps: number): bigint {
  assertSlippageBps(slippageBps);
  // padded = ceil(drops * (10000 + bps) / 10000)
  const numerator = quoteSourceDrops * BigInt(10000 + slippageBps);
  const denominator = 10000n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Compute the realised slippage (bps) of a quote vs. an oracle/spot rate.
 * Used to reject quotes that breach the user-configured cap.
 *
 * @param quoteSourceDrops drops the quote will spend
 * @param amountOutUnits   destination amount in 6-decimal units
 * @param spotRateDropsPerUnit drops-per-unit at oracle/spot
 */
export function computeQuoteSlippageBps(
  quoteSourceDrops: bigint,
  amountOutUnits: bigint,
  spotRateDropsPerUnit: number,
): number {
  if (amountOutUnits <= 0n || spotRateDropsPerUnit <= 0) return 0;
  const expected = BigInt(Math.ceil(Number(amountOutUnits) * spotRateDropsPerUnit));
  if (quoteSourceDrops <= expected) return 0;
  const diff = quoteSourceDrops - expected;
  return Number((diff * 10000n) / expected);
}
