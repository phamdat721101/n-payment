import { NPaymentError } from '../errors.js';
import type { InitiaChainKey } from './types.js';

/**
 * v0.23 — Initia asset registry (iUSD, INIT, AUSD, USDC).
 *
 * Mirrors v0.21 STELLAR_ASSETS pattern — placeholder-tolerant via env override
 * (no module crash at import time when a denom is unpublished).
 *
 * SOLID:
 *   SRP — owns Initia asset metadata only.
 *   OCP — append new symbols; never edit existing.
 *   DIP — callers go through getInitiaAsset(); never read this map directly.
 */

export type InitiaAssetSymbol = 'iUSD' | 'INIT' | 'AUSD' | 'USDC';

export interface InitiaAsset {
  symbol: InitiaAssetSymbol;
  /** Cosmos-SDK denom (e.g. 'uinit', 'ibc/...', 'l2/...'). */
  denom: string;
  decimals: number;
  /** Whether the denom is published-final. */
  verified: boolean;
  /** Env-var key for runtime denom rebinding. */
  envOverride?: string;
}

const PLACEHOLDER = 'placeholder/INITIA_DENOM_PENDING';

export const INITIA_ASSETS: Record<InitiaChainKey, Record<InitiaAssetSymbol, InitiaAsset>> = {
  'initia-mainnet': {
    iUSD: { symbol: 'iUSD', denom: PLACEHOLDER, decimals: 6, verified: false, envOverride: 'INITIA_IUSD_DENOM_MAINNET' },
    INIT: { symbol: 'INIT', denom: 'uinit',     decimals: 6, verified: true },
    AUSD: { symbol: 'AUSD', denom: PLACEHOLDER, decimals: 6, verified: false, envOverride: 'INITIA_AUSD_DENOM_MAINNET' },
    USDC: { symbol: 'USDC', denom: PLACEHOLDER, decimals: 6, verified: false, envOverride: 'INITIA_USDC_DENOM_MAINNET' },
  },
  'initia-testnet': {
    iUSD: { symbol: 'iUSD', denom: PLACEHOLDER, decimals: 6, verified: false, envOverride: 'INITIA_IUSD_DENOM_TESTNET' },
    INIT: { symbol: 'INIT', denom: 'uinit',     decimals: 6, verified: true },
    AUSD: { symbol: 'AUSD', denom: PLACEHOLDER, decimals: 6, verified: false, envOverride: 'INITIA_AUSD_DENOM_TESTNET' },
    USDC: { symbol: 'USDC', denom: PLACEHOLDER, decimals: 6, verified: false, envOverride: 'INITIA_USDC_DENOM_TESTNET' },
  },
};

/** Case-insensitive symbol normalizer. iUSD is the only mixed-case symbol. */
const SYMBOL_NORMALIZER: Record<string, InitiaAssetSymbol> = {
  iusd: 'iUSD',
  init: 'INIT',
  ausd: 'AUSD',
  usdc: 'USDC',
};

/**
 * Resolve a denom by chain + symbol. Env override re-read at call time so test
 * isolation and runtime rebinding both work without module-cache pinning.
 */
export function getInitiaAsset(chain: InitiaChainKey, symbol: string): InitiaAsset {
  const norm = SYMBOL_NORMALIZER[symbol.toLowerCase()];
  if (!norm) {
    throw new NPaymentError(
      `Unknown Initia asset on ${chain}: ${symbol}`,
      'INITIA_ASSET_UNKNOWN',
      `Known: ${Object.keys(SYMBOL_NORMALIZER).join(', ')}`,
    );
  }
  const asset = INITIA_ASSETS[chain][norm];
  if (asset.envOverride) {
    const override = process.env[asset.envOverride];
    if (override && override.length > 0) {
      return { ...asset, denom: override, verified: true };
    }
  }
  return asset;
}

const _warned = new Set<string>();

/** Warn once per (chain,symbol) tuple when a placeholder denom is used. */
export function assertVerifiedDenom(asset: InitiaAsset): void {
  if (asset.verified) return;
  const k = `${asset.symbol}:${asset.denom}`;
  if (_warned.has(k)) return;
  _warned.add(k);
  // eslint-disable-next-line no-console
  console.warn(
    `[n-payment] INITIA_DENOM_PLACEHOLDER: ${asset.symbol} denom is a placeholder. ` +
      `Set ${asset.envOverride} env var with the verified denom to enable production use.`,
  );
}

/** Decimal string → 6-dec base-unit bigint. */
export function parseInitiaAmount(amount: string | number, decimals = 6): bigint {
  const str = String(amount);
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new NPaymentError(
      `Invalid Initia amount: ${str}`,
      'INITIA_AMOUNT_INVALID',
      `Expected decimal string (e.g. '1.5').`,
    );
  }
  const [whole, frac = ''] = str.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

/** Base-unit bigint → decimal string (trailing zeros trimmed). */
export function formatInitiaAmount(amount: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}
