import { getStellarAsset, type StellarAssetSymbol } from './assets.js';
import { NPaymentError } from '../errors.js';

/**
 * v0.21 — Multi-brand-stable PayRouter v2.
 *
 * Pure-function asset selection: given a 402 challenge's requested asset + the
 * buyer's current holdings + an optional corridor hint, picks the optimal Stellar
 * brand stable. When holdings don't include the requested asset, optionally
 * proposes an auto-convert path via Stellar's native AMM.
 *
 * Design:
 *   - SRP — selection logic only. Adapter wiring lives in caller code (the
 *           buyer constructs `StellarSessionClient({ asset })` from the result).
 *   - OCP — new corridors added via `CORRIDOR_PREFERENCE` map only.
 *   - DRY — issuer addresses are read via `getStellarAsset`, never duplicated.
 *
 * Why a pure function (not a class): the legacy v0.20 API surface cannot be
 * extended without breaking changes. A pure exported helper is opt-in: callers
 * who don't invoke it get USDC defaults (back-compat with v0.20).
 */

// ─── Corridor heuristics ────────────────────────────────────────────────────

export type Corridor =
  | 'us-mx'
  | 'us-latam'
  | 'us-ph'
  | 'us-domestic'
  | 'eu-domestic'
  | 'eu-uk'
  | 'eu-latam'
  | 'apac'
  | 'global-default';

/**
 * Per-corridor preference list. Drives auto-convert routing when buyer holds
 * something other than the requested asset. US-MX prefers MGUSD because of
 * MoneyGram's retail off-ramp dominance in that lane.
 */
export const CORRIDOR_PREFERENCE: Record<Corridor, StellarAssetSymbol[]> = {
  'us-mx': ['MGUSD', 'USDC'],
  'us-latam': ['MGUSD', 'USDC'],
  'us-ph': ['MGUSD', 'USDC'],
  'us-domestic': ['USDC', 'MGUSD'],
  'eu-domestic': ['EURC', 'USDC'],
  'eu-uk': ['EURC', 'USDC'],
  'eu-latam': ['EURC', 'MGUSD', 'USDC'],
  'apac': ['USDC'],
  'global-default': ['USDC', 'MGUSD', 'EURC'],
};

// ─── Public input/output shapes ─────────────────────────────────────────────

export interface SelectAssetInput {
  /** Asset the seller listed in the 402 challenge. */
  requested: StellarAssetSymbol;
  /** Assets the buyer holds with positive balances. */
  buyerHoldings: StellarAssetSymbol[];
  /** Optional corridor hint for auto-convert tie-breaking. Default: 'global-default'. */
  corridor?: Corridor;
  /** Optional explicit override of the corridor preference list. */
  sellerPreference?: StellarAssetSymbol[];
  /** When true, allow Stellar AMM path for cross-asset conversion. Default: false. */
  allowAutoConvert?: boolean;
}

export type SelectAssetResult =
  | { kind: 'direct'; asset: StellarAssetSymbol }
  | {
      kind: 'auto-convert';
      from: StellarAssetSymbol;
      to: StellarAssetSymbol;
      via: 'stellar-amm';
      estimatedSlippageBps: number;
    }
  | { kind: 'no-route'; reason: string; suggestedFunding: StellarAssetSymbol[] };

const DEFAULT_SLIPPAGE_BPS = 30; // 0.3% — conservative for low-liquidity early-days pools.

// ─── selectAsset — pure function, no I/O ────────────────────────────────────

/**
 * Pick the optimal Stellar brand stable for the requested asset given buyer holdings.
 * Direct match always wins (zero slippage). When auto-convert is allowed, walks the
 * preference list and proposes the first held candidate as the convert source.
 */
export function selectAsset(input: SelectAssetInput): SelectAssetResult {
  // Validate requested symbol — throws STELLAR_ASSET_UNKNOWN with hint.
  const requested = getStellarAsset(input.requested).code;

  // 1. Direct hit — buyer holds the requested asset.
  if (input.buyerHoldings.includes(requested)) {
    return { kind: 'direct', asset: requested };
  }

  // 2. Build preference: explicit seller pref → corridor → global default. Dedupe.
  const corridor = input.corridor ?? 'global-default';
  const corridorList = CORRIDOR_PREFERENCE[corridor] ?? CORRIDOR_PREFERENCE['global-default'];
  const preference = dedupe([...(input.sellerPreference ?? []), ...corridorList]);

  // 3. If auto-convert is enabled, find the first held candidate as the convert source.
  if (input.allowAutoConvert) {
    for (const candidate of preference) {
      if (input.buyerHoldings.includes(candidate)) {
        return {
          kind: 'auto-convert',
          from: candidate,
          to: requested,
          via: 'stellar-amm',
          estimatedSlippageBps: DEFAULT_SLIPPAGE_BPS,
        };
      }
    }
  }

  // 4. No route — instruct caller which stable(s) to fund.
  const suggestedFunding = dedupe([requested, ...corridorList]).slice(0, 3);
  return {
    kind: 'no-route',
    reason: `Buyer holds [${input.buyerHoldings.join(', ') || 'none'}]; seller wants ${requested}.`,
    suggestedFunding,
  };
}

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ─── Stellar AMM path lookup (used by callers executing auto-convert) ───────

export interface StellarAmmPath {
  /** Slippage of the path in basis points (10 bps = 0.10%). */
  pathBps: number;
  /** Minimum destination amount (base units) for slippage-bounded execution. */
  minDestination: bigint;
  /** XDR-encoded PathPayment op chain (caller submits via stellar-sdk). */
  pathXdr: string;
}

/**
 * Query Horizon `/paths/strict-receive` for a viable AMM path between two assets.
 * Returns null when no path exists (illiquid pool — caller should downgrade to no-route).
 *
 * Kept tiny on purpose: full PathPayment op-construction lives in caller code that
 * already imports @stellar/stellar-sdk; this helper is just the path query.
 */
export async function findStellarAmmPath(
  from: StellarAssetSymbol,
  to: StellarAssetSymbol,
  destinationAmount: bigint,
  horizonUrl: string,
  options?: { maxSlippageBps?: number; sourceAccount?: string },
): Promise<StellarAmmPath | null> {
  const fromAsset = getStellarAsset(from);
  const toAsset = getStellarAsset(to);
  const maxBps = options?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;

  // Format destinationAmount back to a Horizon-friendly decimal string.
  const divisor = 10n ** BigInt(toAsset.decimals);
  const whole = destinationAmount / divisor;
  const frac = (destinationAmount % divisor).toString().padStart(toAsset.decimals, '0');
  const destinationAmountStr = `${whole}.${frac}`;

  const params = new URLSearchParams({
    destination_asset_type: 'credit_alphanum4',
    destination_asset_code: toAsset.code,
    destination_asset_issuer: toAsset.issuer,
    destination_amount: destinationAmountStr,
    source_assets: `${fromAsset.code}:${fromAsset.issuer}`,
  });
  if (options?.sourceAccount) params.set('source_account', options.sourceAccount);

  const res = await fetch(`${horizonUrl.replace(/\/$/, '')}/paths/strict-receive?${params.toString()}`);
  if (!res.ok) {
    throw new NPaymentError(
      `Stellar AMM path lookup failed: ${res.status} ${res.statusText}`,
      'STELLAR_AMM_PATH_LOOKUP_FAILED',
      `Verify horizonUrl is reachable and asset pair (${from}→${to}) has on-chain liquidity.`,
    );
  }
  const body = (await res.json()) as { _embedded?: { records?: Array<{ source_amount: string; path: unknown[] }> } };
  const record = body._embedded?.records?.[0];
  if (!record) return null;

  // Slippage estimate: ratio of source_amount to destination_amount, expressed in bps
  // relative to a 1:1 stable parity. Conservative ceiling.
  const sourceAmount = parseFloat(record.source_amount);
  const destAmount = parseFloat(destinationAmountStr);
  const drift = Math.abs(sourceAmount - destAmount) / Math.max(destAmount, 1e-9);
  const pathBps = Math.min(Math.ceil(drift * 10_000), maxBps);

  // Slippage-bounded minimum destination = destination - maxBps tolerance.
  const minDestination =
    destinationAmount - (destinationAmount * BigInt(maxBps)) / 10_000n;

  return {
    pathBps,
    minDestination,
    pathXdr: JSON.stringify(record.path), // raw path; caller wraps in PathPaymentStrictReceive op
  };
}
