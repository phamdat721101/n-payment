/**
 * v0.25 — Mento corridor (USDm + cKES + cREAL → USDC).
 *
 * Pure-function path selection — no I/O. The broker client (`mento-broker.ts`)
 * is injected via `MentoCorridorInput.broker`; tests can pass a mock to fully
 * unit-test the decision tree without an RPC. v0.25 ships only the 3 stables
 * required to prove the corridor primitive — additional Mento brand stables
 * (cCOP, cGHS, cZAR, eXOF, …) land in v0.26+ as merchant demand emerges.
 *
 * SOLID — Single Responsibility: this file only OWNS path selection. The
 * MentoBrokerClient owns on-chain reads. The fee-abstracted broadcast path
 * lives in `mento-broker.ts::swapIn` (which itself delegates the CIP-64
 * wrapping to CeloFeeAbstractedTransactor — no logic duplicated here).
 */
import type { Address } from 'viem';
import type { MentoBrokerClient } from './mento-broker.js';

export type MentoAssetSymbol = 'USDm' | 'cKES' | 'cREAL';

export interface MentoAsset {
  symbol: MentoAssetSymbol;
  address: Address;
  decimals: number;
}

/**
 * Mento brand-stable registry (v0.25 ships 3). All amounts are 18-dec.
 * Addresses are mainnet — sepolia testnet does not yet host cKES/cREAL,
 * so the corridor only quotes USDm on testnet (callers receive
 * `kind: 'no-route'` for cKES/cREAL on celo-sepolia).
 */
export const MENTO_ASSETS: Record<MentoAssetSymbol, MentoAsset> = {
  USDm:  { symbol: 'USDm',  address: '0x765DE816845861e75A25fCA122bb6898B8B1282a', decimals: 18 },
  cKES:  { symbol: 'cKES',  address: '0x456a3D042C0DbD3db53D5489e98dFb038553B0d0', decimals: 18 },
  cREAL: { symbol: 'cREAL', address: '0xE4D517785D091D3c54818832dB6094bcc2744545', decimals: 18 },
};

export interface MentoCorridorLeg {
  assetIn:  MentoAssetSymbol | 'USDC';
  assetOut: MentoAssetSymbol | 'USDC';
  amountIn: bigint;
  expectedOut: bigint;
}

export type MentoCorridorDecision =
  | { kind: 'direct-mento';        legs: [MentoCorridorLeg]; expectedOut: bigint; slippageBps: number }
  | { kind: 'via-usdm';             legs: [MentoCorridorLeg, MentoCorridorLeg]; expectedOut: bigint; slippageBps: number }
  | { kind: 'no-route';             reason: string };

export interface MentoCorridorInput {
  assetIn:  MentoAssetSymbol;
  assetOut: 'USDC' | MentoAssetSymbol;
  amountIn: bigint;
  /** Injected broker for live quotes — pass a mock in unit tests. */
  broker:   Pick<MentoBrokerClient, 'getAmountOut'>;
  /** @default 50 (0.5 %) */
  maxSlippageBps?: number;
  /** Optional minimum out hint from caller; corridor enforces it. */
  minOut?: bigint;
}

const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * Pick the cheapest viable Mento path for {assetIn → assetOut}.
 *
 * Decision tree (v0.25):
 *   • USDm  → USDC : single-leg (Mento broker quotes USDm/USDC pool)
 *   • cKES  → USDC : two-leg via USDm
 *   • cREAL → USDC : two-leg via USDm
 *   • USDm  → USDm : noop (returned as direct-mento with 0 slippage)
 *   • Any pair where broker.getAmountOut() reverts or returns 0 → no-route.
 */
export async function selectMentoCorridor(input: MentoCorridorInput): Promise<MentoCorridorDecision> {
  if (input.amountIn <= 0n) {
    return { kind: 'no-route', reason: 'amountIn must be positive' };
  }
  if (!(input.assetIn in MENTO_ASSETS)) {
    return { kind: 'no-route', reason: `Unknown source asset: ${input.assetIn}` };
  }
  const slipBps = input.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const usdc = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as Address;

  // ── direct USDm → USDC ────────────────────────────────────────────────────
  if (input.assetIn === 'USDm' && input.assetOut === 'USDC') {
    const out = await safeQuote(input.broker, MENTO_ASSETS.USDm.address, usdc, input.amountIn);
    if (out === null) return { kind: 'no-route', reason: 'mento-circuit-breaker' };
    if (out === 0n)   return { kind: 'no-route', reason: 'mento-zero-quote' };
    if (slippageBps(input.amountIn, out) > slipBps) {
      return { kind: 'no-route', reason: `slippage exceeds ${slipBps} bps` };
    }
    if (input.minOut && out < input.minOut) {
      return { kind: 'no-route', reason: `expected ${out} below minOut ${input.minOut}` };
    }
    return {
      kind: 'direct-mento',
      legs: [{ assetIn: 'USDm', assetOut: 'USDC', amountIn: input.amountIn, expectedOut: out }],
      expectedOut: out,
      slippageBps: slippageBps(input.amountIn, out),
    };
  }

  // ── two-leg cKES/cREAL → USDm → USDC ─────────────────────────────────────
  if ((input.assetIn === 'cKES' || input.assetIn === 'cREAL') && input.assetOut === 'USDC') {
    const leg1Out = await safeQuote(
      input.broker,
      MENTO_ASSETS[input.assetIn].address,
      MENTO_ASSETS.USDm.address,
      input.amountIn,
    );
    if (leg1Out === null) return { kind: 'no-route', reason: 'mento-circuit-breaker' };
    if (leg1Out === 0n)   return { kind: 'no-route', reason: 'mento-zero-quote-leg1' };
    const leg2Out = await safeQuote(input.broker, MENTO_ASSETS.USDm.address, usdc, leg1Out);
    if (leg2Out === null) return { kind: 'no-route', reason: 'mento-circuit-breaker' };
    if (leg2Out === 0n)   return { kind: 'no-route', reason: 'mento-zero-quote-leg2' };
    // Slippage applies to the combined hop (input vs final out, both 18-dec
    // for Mento stables). Caller separately accounts for FX rate (KES/USD).
    // We only enforce slippage on the USDm → USDC leg since the FX leg
    // legitimately changes USD-equivalent value.
    if (slippageBps(leg1Out, leg2Out) > slipBps) {
      return { kind: 'no-route', reason: `leg2 slippage exceeds ${slipBps} bps` };
    }
    if (input.minOut && leg2Out < input.minOut) {
      return { kind: 'no-route', reason: `expected ${leg2Out} below minOut ${input.minOut}` };
    }
    return {
      kind: 'via-usdm',
      legs: [
        { assetIn: input.assetIn, assetOut: 'USDm', amountIn: input.amountIn, expectedOut: leg1Out },
        { assetIn: 'USDm',         assetOut: 'USDC', amountIn: leg1Out,        expectedOut: leg2Out },
      ],
      expectedOut: leg2Out,
      slippageBps: slippageBps(leg1Out, leg2Out),
    };
  }

  // Any other unsupported pair (e.g. cKES → cREAL direct).
  return { kind: 'no-route', reason: `Unsupported pair: ${input.assetIn} → ${input.assetOut}` };
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function safeQuote(
  broker: Pick<MentoBrokerClient, 'getAmountOut'>,
  assetIn: Address,
  assetOut: Address,
  amountIn: bigint,
): Promise<bigint | null> {
  try {
    return await broker.getAmountOut(assetIn, assetOut, amountIn);
  } catch {
    return null;
  }
}

/** Slippage in bps measured against the in→out 1:1 baseline (positive = loss). */
function slippageBps(amountIn: bigint, amountOut: bigint): number {
  if (amountIn === 0n) return 0;
  if (amountOut >= amountIn) return 0;
  const lostScaled = ((amountIn - amountOut) * 10_000n) / amountIn;
  return Number(lostScaled);
}
