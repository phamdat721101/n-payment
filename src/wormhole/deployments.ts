/**
 * v0.22 — RLUSD multichain Wormhole NTT deployment registry.
 *
 * Source-of-truth: github.com/wormhole-foundation/connect-w blob 62f8216 — RLUSD.json
 * (commit 62f8216d726513240240bee3b20b8ffd1a436daa, June 4 2026).
 *
 * NTT 1.1.0, burn-and-mint mode, threshold=1, single Wormhole transceiver.
 * All 5 chains share the same NttManager and Transceiver address (Wormhole
 * CREATE2 deterministic addressing) — the SDK relies on this invariant.
 *
 * NOTE: Outbound limit is 0 on every chain — Ripple is gating supply during
 * the ramp. Inbound limits sit at 50M per partner chain. These are static
 * snapshots; v0.23 will add live on-chain reads via NttManager getters.
 */

import type { ChainKey } from '../types.js';
import type { CanBridgeResult, NttDeployment, WormholeChainName } from './types.js';

export type { CanBridgeResult, NttDeployment, WormholeChainName };

// ─── Static deployment data ──────────────────────────────────────────────────

const FIFTY_M = 50_000_000n * 10n ** 18n;
const NTT_MANAGER = '0x2a71afb11F4633A2681EAa19A01C47990f67E938' as const;
const TRANSCEIVER = '0x7B17Afd3A51ca042cB70A8A334BC4f171fd74089' as const;
const RIPPLE_OWNER = '0x395886E76217Ae8Ac89340a51083667582D68722' as const;
const RLUSD_ETH = '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD' as const;
const RLUSD_L2 = '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258' as const;

export const RLUSD_NTT_DEPLOYMENTS: Readonly<Record<WormholeChainName, NttDeployment>> = Object.freeze({
  Ethereum: {
    chainName: 'Ethereum',
    chainId: 1,
    manager: NTT_MANAGER,
    token: RLUSD_ETH,
    transceiver: TRANSCEIVER,
    threshold: 1,
    mode: 'burning',
    inboundLimits: { Base: FIFTY_M, Optimism: FIFTY_M, Unichain: FIFTY_M, Ink: FIFTY_M },
    outboundLimit: 0n,
    paused: false,
    owner: RIPPLE_OWNER,
  },
  Base: {
    chainName: 'Base',
    chainId: 8453,
    manager: NTT_MANAGER,
    token: RLUSD_L2,
    transceiver: TRANSCEIVER,
    threshold: 1,
    mode: 'burning',
    inboundLimits: { Optimism: FIFTY_M, Unichain: FIFTY_M, Ink: FIFTY_M },
    outboundLimit: 0n,
    paused: false,
    owner: RIPPLE_OWNER,
  },
  Optimism: {
    chainName: 'Optimism',
    chainId: 10,
    manager: NTT_MANAGER,
    token: RLUSD_L2,
    transceiver: TRANSCEIVER,
    threshold: 1,
    mode: 'burning',
    inboundLimits: { Base: FIFTY_M, Unichain: FIFTY_M, Ink: FIFTY_M },
    outboundLimit: 0n,
    paused: false,
    owner: RIPPLE_OWNER,
  },
  Ink: {
    chainName: 'Ink',
    chainId: 57073,
    manager: NTT_MANAGER,
    token: RLUSD_L2,
    transceiver: TRANSCEIVER,
    threshold: 1,
    mode: 'burning',
    inboundLimits: { Base: FIFTY_M, Optimism: FIFTY_M, Unichain: FIFTY_M },
    outboundLimit: 0n,
    paused: false,
    owner: RIPPLE_OWNER,
  },
  Unichain: {
    chainName: 'Unichain',
    chainId: 130,
    manager: NTT_MANAGER,
    token: RLUSD_L2,
    transceiver: TRANSCEIVER,
    threshold: 1,
    mode: 'burning',
    inboundLimits: { Base: FIFTY_M, Optimism: FIFTY_M, Ink: FIFTY_M },
    outboundLimit: 0n,
    paused: false,
    owner: RIPPLE_OWNER,
  },
});

// ─── ChainKey ↔ WormholeChainName mapping ────────────────────────────────────

export const CHAIN_KEY_TO_WH: Readonly<Partial<Record<ChainKey, WormholeChainName>>> = Object.freeze({
  'ethereum-mainnet': 'Ethereum',
  'base-mainnet': 'Base',
  'optimism-mainnet': 'Optimism',
  'ink-mainnet': 'Ink',
  'unichain-mainnet': 'Unichain',
});

const WH_TO_CHAIN_KEY: Readonly<Record<WormholeChainName, ChainKey>> = Object.freeze({
  Ethereum: 'ethereum-mainnet',
  Base: 'base-mainnet',
  Optimism: 'optimism-mainnet',
  Ink: 'ink-mainnet',
  Unichain: 'unichain-mainnet',
});

/** Resolve a ChainKey to its Wormhole chain name. Returns undefined for non-NTT chains. */
export function whChainFromKey(key: ChainKey): WormholeChainName | undefined {
  return CHAIN_KEY_TO_WH[key];
}

/** Resolve a Wormhole chain name to its ChainKey. */
export function chainKeyFromWh(name: WormholeChainName): ChainKey {
  return WH_TO_CHAIN_KEY[name];
}

// ─── Pure-function feasibility check ─────────────────────────────────────────

/**
 * Pure-fn preflight: can we bridge `amount` RLUSD `from → to` right now?
 * Returns a structured reason on failure. Outbound limit gating is the
 * dominant constraint today (statically 0 across all 5 chains).
 *
 * Pass `liveLimits` to override the static snapshot — typically obtained
 * from on-chain `NttManager.getCurrentOutboundCapacity()` /
 * `NttManager.getCurrentInboundCapacity(peer)` reads.
 */
export function canBridgeRlusd(
  from: WormholeChainName,
  to: WormholeChainName,
  amount: bigint,
  liveLimits?: { outbound?: bigint; inbound?: bigint },
): CanBridgeResult {
  if (from === to) return { ok: false, reason: 'same-chain' };
  if (amount <= 0n) return { ok: false, reason: 'invalid-amount' };

  const src = RLUSD_NTT_DEPLOYMENTS[from];
  const dst = RLUSD_NTT_DEPLOYMENTS[to];
  if (!src || !dst) return { ok: false, reason: 'chain-not-supported' };
  if (src.paused || dst.paused) return { ok: false, reason: 'paused' };

  const outbound = liveLimits?.outbound ?? src.outboundLimit;
  if (outbound < amount) {
    return {
      ok: false,
      reason: `outbound-limit-exceeded (${outbound} < ${amount})`,
      suggestedFunding: 'native',
    };
  }

  const inboundCap = liveLimits?.inbound ?? dst.inboundLimits[from] ?? 0n;
  if (inboundCap < amount) {
    return { ok: false, reason: `inbound-limit-exceeded (${inboundCap} < ${amount})` };
  }
  return { ok: true };
}
