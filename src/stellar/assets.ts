import { NPaymentError } from '../errors.js';

/**
 * v0.21 — Stellar brand-stablecoin registry.
 *
 * Single source of truth for the brand stables that coexist on Stellar today.
 * Curated set: USDC + EURC + MGUSD (MoneyGram, launched 2026-06-02). RLUSD and
 * PYUSD are deferred until verified Stellar issuers exist (avoids placeholder
 * drift across modules).
 *
 * Pattern matches v0.17 `goat.usdcOverride` — unverified issuer addresses ship
 * as placeholders behind an env override, never blocking the SDK at import time.
 *
 * Design (SOLID):
 *   - SRP — this module owns asset metadata + decimal helpers, nothing else.
 *   - OCP — additional brand stables added via PR (env override at runtime).
 *   - DIP — downstream (`session`, `asset-router`, `stellar-anchor`, `kya`)
 *           depend on `getStellarAsset` not on hard-coded issuer strings.
 */

export type StellarAssetSymbol = 'USDC' | 'EURC' | 'MGUSD';

export interface StellarAsset {
  /** Canonical Stellar asset code (≤12 chars). */
  code: StellarAssetSymbol;
  /** Stellar G... issuer address (56 chars). May be placeholder pending publication. */
  issuer: string;
  /** Display symbol (= code in v0.21). */
  symbol: string;
  /** Stellar canonical decimals = 7. Carried explicitly for parse/format helpers. */
  decimals: 7;
  /** Brand owner (for routing heuristics + display). */
  brand: 'circle' | 'circle-eur' | 'moneygram';
  /** Underlying issuance infra (modular-stack thesis). */
  infra: 'circle' | 'm0';
  /** Whether the issuer address is verified or a placeholder pending publication. */
  verified: boolean;
  /** Optional Anchor Directory hint for SEP-24/31 lookup in `offramp/stellar-anchor`. */
  anchorDirectoryEntry?: { home_domain: string; name: string };
  /** Env-var key for runtime issuer rebinding (verified=true override path). */
  envOverride?: string;
}

/**
 * Stellar's "null account" — 56-char base32 G-prefix shape, all-zero ed25519 pubkey.
 * Used as a placeholder until the real Bridge MGUSD issuer is published; downstream
 * code that calls Soroban will surface STELLAR_ASSET_PLACEHOLDER_ISSUER before any
 * on-chain interaction. Operators set STELLAR_MGUSD_ISSUER to override at runtime.
 */
export const MGUSD_ISSUER_PLACEHOLDER =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHATTHEHELLOMGUSD'.slice(0, 56);

/** Module-load-time map; env overrides re-resolved at call time in `getStellarAsset`. */
export const STELLAR_ASSETS: Record<StellarAssetSymbol, StellarAsset> = {
  USDC: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    symbol: 'USDC',
    decimals: 7,
    brand: 'circle',
    infra: 'circle',
    verified: true,
    anchorDirectoryEntry: { home_domain: 'circle.com', name: 'Circle' },
  },
  EURC: {
    code: 'EURC',
    issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
    symbol: 'EURC',
    decimals: 7,
    brand: 'circle-eur',
    infra: 'circle',
    verified: true,
    anchorDirectoryEntry: { home_domain: 'circle.com', name: 'Circle EURC' },
  },
  MGUSD: {
    code: 'MGUSD',
    issuer: MGUSD_ISSUER_PLACEHOLDER,
    symbol: 'MGUSD',
    decimals: 7,
    brand: 'moneygram',
    infra: 'm0',
    verified: false,
    anchorDirectoryEntry: { home_domain: 'moneygram.com', name: 'MoneyGram' },
    envOverride: 'STELLAR_MGUSD_ISSUER',
  },
};

export const STELLAR_ASSET_SYMBOLS = Object.keys(STELLAR_ASSETS) as StellarAssetSymbol[];

/**
 * Resolve an asset by symbol (case-insensitive). Re-reads env overrides at call time
 * so test isolation and runtime rebinding both work (no module-cache pinning).
 */
export function getStellarAsset(symbol: string): StellarAsset {
  const upper = symbol.toUpperCase() as StellarAssetSymbol;
  const asset = STELLAR_ASSETS[upper];
  if (!asset) {
    throw new NPaymentError(
      `Unknown Stellar asset: ${symbol}`,
      'STELLAR_ASSET_UNKNOWN',
      `Known assets: ${STELLAR_ASSET_SYMBOLS.join(', ')}`,
    );
  }
  if (asset.envOverride) {
    const override = process.env[asset.envOverride];
    if (override && override.length > 0) {
      return { ...asset, issuer: override, verified: true };
    }
  }
  return asset;
}

/** Warn-once helper for placeholder issuers — operators see exactly one line per asset per process. */
const _warned = new Set<string>();
export function assertVerifiedIssuer(asset: StellarAsset): void {
  if (asset.verified) return;
  if (_warned.has(asset.code)) return;
  _warned.add(asset.code);
  // Use console.warn so test runners can capture it without throwing.
  // eslint-disable-next-line no-console
  console.warn(
    `[n-payment] STELLAR_ASSET_PLACEHOLDER_ISSUER: ${asset.code} issuer is a placeholder. ` +
      `Set ${asset.envOverride ?? `STELLAR_${asset.code}_ISSUER`} env var with the verified issuer address.`,
  );
}

/**
 * Parse a decimal display string (e.g. `'1.5'`) into base-unit bigint (e.g. `15_000_000n` for 7 decimals).
 * Truncates excess fractional digits (does not round) — matches v0.20 `parseSpace` semantics.
 */
export function parseStellarAsset(amount: string | number, symbol: string): bigint {
  const asset = getStellarAsset(symbol);
  const str = String(amount);
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new NPaymentError(
      `Invalid amount for ${symbol}: ${str}`,
      'STELLAR_ASSET_INVALID_AMOUNT',
      `Expected decimal string with up to ${asset.decimals} decimals (e.g. '1.5').`,
    );
  }
  const [whole, frac = ''] = str.split('.');
  const padded = (frac + '0'.repeat(asset.decimals)).slice(0, asset.decimals);
  return BigInt(whole) * 10n ** BigInt(asset.decimals) + BigInt(padded || '0');
}

/**
 * Format a base-unit bigint into a decimal display string. `displayDecimals` lets callers
 * truncate trailing zeros (e.g. `'1.50'` instead of `'1.5000000'`). Defaults to asset decimals.
 */
export function formatStellarAsset(
  amount: bigint,
  symbol: string,
  displayDecimals?: number,
): string {
  const asset = getStellarAsset(symbol);
  const dd = displayDecimals ?? asset.decimals;
  const divisor = 10n ** BigInt(asset.decimals);
  const whole = amount / divisor;
  if (dd === 0) return whole.toString();
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(asset.decimals, '0').slice(0, dd);
  return `${whole}.${fracStr}`;
}
