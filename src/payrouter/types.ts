import type { Address } from 'viem';
import type { ChainKey } from '../types.js';

/**
 * v0.22 — PayRouter v3 corridor decision contracts.
 * v0.22.1 — Extended with 3 XRPFi decision kinds (PRD-G).
 *
 * The corridor is a pure function: given the buyer's holdings and the merchant's
 * requirement, produce a decision tree describing the cheapest path.
 */

export type Corridor = 'us-direct' | 'us-mx' | 'eu-uk' | 'apac' | 'global-default';

export interface CorridorRouteInput {
  /** Asset the seller demands. v0.22 supports 'RLUSD' only. */
  requestedAsset: 'RLUSD';
  /** Chain the seller demands payment on. */
  requestedChain: ChainKey;
  /** RLUSD amount in 18-decimal base units (UBA). */
  requestedAmount: bigint;
  /** Buyer's RLUSD balances per chain (UBA). */
  buyerHoldings: Partial<Record<ChainKey, bigint>>;

  // ── v0.22.1 — XRPFi inputs ──────────────────────────────────────────────
  /** XRPL-side balances (drops for XRP, UBA for RLUSD-XRPL). */
  xrplHoldings?: { xrpDrops?: bigint; rlusdXrpl?: bigint };
  /** Flare-side balances (UBA — FXRP shares the 6-dec UBA scale with XRP). */
  flareHoldings?: { fxrp?: bigint };
  /** Enable XRPFi corridor decisions. Default false (back-compat with v0.22.0). */
  allowXrpfi?: boolean;
  /**
   * When true, the reverse leg attempts a final NTT bridge step using the
   * existing WormholeNttAdapter. Pre-wired — emits decision today but the
   * bridge step only resolves when XRPL is in RLUSD_NTT_DEPLOYMENTS.
   */
  allowReverseBridge?: boolean;

  /** Optional corridor hint. Default 'global-default'. */
  corridor?: Corridor;
  /** Live limits override (e.g. via on-chain reads). */
  liveLimits?: { outbound?: bigint; inbound?: bigint };
}

export type CorridorRouteDecision =
  | { kind: 'direct'; chain: ChainKey }
  | { kind: 'ntt-bridge'; fromChain: ChainKey; toChain: ChainKey; amount: bigint }
  // ── v0.22.1 — XRPFi paths ────────────────────────────────────────────────
  /**
   * Forward partial — buyer holds XRP-XRPL only, merchant wants RLUSD on EVM.
   * SDK mints FXRP on Flare; full forward closure (FXRP → RLUSD-EVM) requires
   * Flare in NTT registry, which is a v0.23 / external roadmap item.
   */
  | {
      kind: 'xrpfi-mint-fxrp';
      amountXrp: bigint;
      /** Fall-back informational chain — communicates the gap to caller. */
      stopChain: 'flare-mainnet';
    }
  /**
   * Reverse — buyer holds FXRP, merchant wants RLUSD on XRPL.
   * Flow: FXRP → redeem → XRP on XRPL → swap to RLUSD-XRPL.
   */
  | {
      kind: 'xrpfi-redeem-then-swap';
      amountFxrp: bigint;
      xrplDestination: string;
      expectedRlusdXrpl: bigint;
    }
  /**
   * Reverse + bridge — same as redeem-then-swap, then bridge to EVM via NTT.
   * Active only when XRPL is in RLUSD_NTT_DEPLOYMENTS (registry update unlocks).
   */
  | {
      kind: 'xrpfi-redeem-swap-then-bridge';
      amountFxrp: bigint;
      xrplDestination: string;
      bridgeToChain: ChainKey;
      bridgeAmount: bigint;
    }
  | { kind: 'no-route'; reason: string; suggestedFunding: ChainKey[] };
