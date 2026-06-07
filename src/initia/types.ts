import type { ChainKey } from '../types.js';

/**
 * v0.23 — Initia (Cosmos-SDK L1 + Interwoven Rollup) integration types.
 *
 * SOLID:
 *   SRP — this module owns Initia/iUSD type contracts only.
 *   OCP — extend by appending; never edit existing.
 *   DIP — runtime classes consume these types; never the concrete cosmos SDKs.
 */

export type InitiaNetwork = 'mainnet' | 'testnet';

/** Cosmos-SDK chain key subset (always two strings — keeps narrowing trivial). */
export type InitiaChainKey = 'initia-mainnet' | 'initia-testnet';

export type IusdCorridor =
  | 'iusd-direct'             // already on Initia — pay via cosmos MsgSend
  | 'skip-api'                // USDC anywhere → iUSD-Initia via Skip multi-hop
  | 'layerzero-ausd'          // AUSD-Eth → AUSD-Initia via LayerZero OFT → mint iUSD
  | 'wormhole-ntt-fallback';  // reuse v0.22 NTT for the EVM leg, then Skip leg

/** Per-leg shape inside a corridor decision (audit-log serialisable). */
export interface IusdCorridorStep {
  rail: IusdCorridor;
  fromChain?: ChainKey;
  toChain: ChainKey;
  asset: 'USDC' | 'AUSD' | 'iUSD';
  amount: bigint;
  estimatedSec: number;
}

export type IusdCorridorResult =
  | { kind: 'direct'; chain: InitiaChainKey }
  | {
      kind: 'bridge';
      corridor: IusdCorridor;
      steps: IusdCorridorStep[];
      estimatedSec: number;
      estimatedFeeBps: number;
    }
  | { kind: 'no-route'; reason: string; suggestedFunding: ChainKey[] };

/** Pure-fn input to selectIusdCorridor. */
export interface IusdCorridorInput {
  /** Initia chain the merchant demands payment on. */
  requestedChain: InitiaChainKey;
  /** iUSD base units (6 decimals). */
  requestedAmount: bigint;
  /** Buyer iUSD per Initia chain. */
  iusdHoldings?: Partial<Record<InitiaChainKey, bigint>>;
  /** Buyer AUSD-on-Ethereum (enables 'layerzero-ausd' rail). */
  ausdHoldings?: Partial<Record<ChainKey, bigint>>;
  /** Buyer USDC per EVM chain (enables 'skip-api' / 'wormhole-ntt-fallback' rails). */
  usdcHoldings?: Partial<Record<ChainKey, bigint>>;
  /** Skip API health gate. @default true */
  skipApiHealthy?: boolean;
  /** LayerZero AUSD-OFT availability gate (testnet often false). @default false */
  layerZeroAvailable?: boolean;
}

// ─── Skip API contracts ──────────────────────────────────────────────────────

export interface SkipQuoteRequest {
  srcChainId: string;        // Cosmos chain-id ('1' for Ethereum, 'initiation-2' for Initia testnet)
  srcAssetDenom: string;     // EVM 0x... or cosmos denom
  dstChainId: string;
  dstAssetDenom: string;
  amountIn: string;          // base units (decimal string)
  slippageTolerancePercent?: string; // e.g. '1' = 1%
}

export interface SkipQuoteResponse {
  amountOut: string;
  estimatedFeeBps: number;
  estimatedSec: number;
  /** Opaque route blob for submitRoute. Skip's API returns the full operations[] array. */
  route: unknown;
}

// ─── Config (consumed via NPaymentConfig.initia / .iusd) ─────────────────────

export interface InitiaConfig {
  /** @default 'testnet' */
  network?: InitiaNetwork;
  /** Override RPC URL. */
  rpcUrl?: string;
  /** Override REST/LCD URL. */
  restUrl?: string;
  /**
   * BIP-39 mnemonic (testnet/dev). Production agents should construct an
   * `OfflineDirectSigner` externally and pass it via {@link InitiaClient}'s
   * `signer` constructor arg directly. The mnemonic path is convenience-only.
   */
  mnemonic?: string;
  /** Throw on missing peer-dep / signer instead of soft-disabling. @default false */
  strict?: boolean;
}

export interface IusdConfig {
  /** Skip API base URL override (testnet variant). */
  skipApiUrl?: string;
  /** Quote in-memory cache TTL (ms). @default 30_000 */
  quoteCacheTtlMs?: number;
  /** When true, attempt LayerZero rail before Skip. Default false (Skip is canonical). */
  preferLayerZero?: boolean;
}
