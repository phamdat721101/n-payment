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
/**
 * Canonical 40-hex XRPL currency code for RLUSD. The XRPL exact x402 scheme
 * (T54 reference impl) uses this in `accepts[].asset`; the human-readable
 * "RLUSD" symbol is accepted only when explicitly converted by the caller.
 *
 * Source: https://xrpl-x402.t54.ai/docs/xrpl-scheme#asset-types
 */
export const RLUSD_HEX = '524C555344000000000000000000000000000000' as const;

/**
 * Default XRPL `SourceTag` stamped on x402 Payment transactions. Used by
 * T54's `x402scan` indexer to identify x402 traffic on-chain. Override per
 * route via `route.xrpl.sourceTag` or globally via `xrpl.sourceTag`.
 *
 * Source: https://xrpl-x402.t54.ai/docs/xrpl-scheme#requirements-fields
 */
export const DEFAULT_SOURCE_TAG = 804681468 as const;

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

// ─── CAIP-2 helpers (T54 / x402 v2) ──────────────────────────────────────────

/** CAIP-2 network ID per the XRPL x402 spec: xrpl:0 = mainnet, xrpl:1 = testnet, xrpl:2 = devnet. */
export type XrplCaip2 = 'xrpl:0' | 'xrpl:1' | 'xrpl:2';

const CAIP2_BY_NETWORK: Readonly<Record<XrplNetwork, XrplCaip2>> = Object.freeze({
  mainnet: 'xrpl:0',
  testnet: 'xrpl:1',
});

/** XrplNetwork → CAIP-2 ID. */
export function toCaip2(network: XrplNetwork): XrplCaip2 {
  return CAIP2_BY_NETWORK[network];
}

/**
 * CAIP-2 ID → XrplNetwork. Throws on unknown values.
 * Devnet (`xrpl:2`) currently maps to 'testnet' since n-payment registry has no devnet entry.
 */
export function parseCaip2(caip2: string): XrplNetwork {
  switch (caip2) {
    case 'xrpl:0':
      return 'mainnet';
    case 'xrpl:1':
      return 'testnet';
    case 'xrpl:2':
      return 'testnet';
    default:
      throw new NPaymentError(
        `Unsupported XRPL CAIP-2 network: ${JSON.stringify(caip2)}`,
        'XRPL_INVALID_NETWORK',
        'Use xrpl:0 (mainnet), xrpl:1 (testnet), or xrpl:2 (devnet).',
      );
  }
}

/**
 * Resolve a "soft" asset reference to the canonical XRPL form used by the
 * exact scheme: `'XRP'` stays `'XRP'`; `'RLUSD'` is upgraded to its 40-hex
 * code; an already-hex code passes through unchanged.
 */
export function resolveCanonicalAsset(asset: string): string {
  if (asset === 'XRP') return 'XRP';
  if (asset === 'RLUSD') return RLUSD_HEX;
  if (/^[0-9A-F]{40}$/i.test(asset)) return asset.toUpperCase();
  throw new NPaymentError(
    `Unknown XRPL asset reference: ${JSON.stringify(asset)}`,
    'XRPL_INVALID_ASSET',
    'Use "XRP", "RLUSD", or a 40-hex XRPL currency code.',
  );
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
