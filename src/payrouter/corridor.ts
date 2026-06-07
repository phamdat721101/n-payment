import type { ChainKey } from '../types.js';
import { canBridgeRlusd, whChainFromKey } from '../wormhole/deployments.js';
import type { CorridorRouteDecision, CorridorRouteInput } from './types.js';

/**
 * Priority order when buyer holds RLUSD on multiple bridgeable EVM source chains.
 * Picks the chain with cheapest gas + fastest VAA finality first.
 *
 * v0.23 will read live outbound/inbound limits to override this static order.
 */
const NTT_SOURCE_PRIORITY: ChainKey[] = [
  'optimism-mainnet',
  'base-mainnet',
  'unichain-mainnet',
  'ink-mainnet',
  'ethereum-mainnet',
];

/** Chain keys that are NTT-eligible for RLUSD as of v0.22 (matches RLUSD_NTT_DEPLOYMENTS). */
const NTT_RLUSD_CHAINS: ReadonlySet<ChainKey> = new Set<ChainKey>([
  'ethereum-mainnet',
  'base-mainnet',
  'optimism-mainnet',
  'ink-mainnet',
  'unichain-mainnet',
]);

/**
 * v0.22 PayRouter v3 — RLUSD cross-chain corridor selector.
 * v0.22.1 — Extended with 3 XRPFi decision kinds (PRD-G).
 *
 * Algorithm (in order, first match wins):
 *   1. Direct hit — buyer already holds RLUSD on the requested chain.
 *   2. NTT bridge — buyer holds RLUSD on another EVM chain in the registry.
 *   2.5 (XRPFi reverse, opt-in) — reqChain == xrpl-mainnet AND buyer holds FXRP.
 *   2.6 (XRPFi forward, opt-in) — reqChain in EVM AND buyer holds only XRP-XRPL.
 *   3. No route — return suggestedFunding chain list.
 *
 * Pure function — no I/O, no side effects.
 */
export function selectRlusdCorridor(input: CorridorRouteInput): CorridorRouteDecision {
  const { requestedChain, requestedAmount, buyerHoldings, liveLimits } = input;
  if (requestedAmount <= 0n) {
    return { kind: 'no-route', reason: 'invalid-amount', suggestedFunding: [requestedChain] };
  }

  // Step 1: direct hit
  const direct = buyerHoldings[requestedChain] ?? 0n;
  if (direct >= requestedAmount) {
    return { kind: 'direct', chain: requestedChain };
  }

  // Step 2: NTT bridge — only when destination is an EVM chain in the registry
  if (NTT_RLUSD_CHAINS.has(requestedChain)) {
    const dstWh = whChainFromKey(requestedChain);
    if (dstWh) {
      for (const candidateKey of NTT_SOURCE_PRIORITY) {
        if (candidateKey === requestedChain) continue;
        const balance = buyerHoldings[candidateKey] ?? 0n;
        if (balance < requestedAmount) continue;
        const srcWh = whChainFromKey(candidateKey);
        if (!srcWh) continue;
        const decision = canBridgeRlusd(srcWh, dstWh, requestedAmount, liveLimits);
        if (decision.ok) {
          return {
            kind: 'ntt-bridge',
            fromChain: candidateKey,
            toChain: requestedChain,
            amount: requestedAmount,
          };
        }
      }
    }
  }

  // ── v0.22.1 — XRPFi paths (opt-in via allowXrpfi) ─────────────────────────
  if (input.allowXrpfi) {
    const fxrp = input.flareHoldings?.fxrp ?? 0n;
    const xrpDrops = input.xrplHoldings?.xrpDrops ?? 0n;

    // Step 2.5 — reverse: reqChain = xrpl-mainnet, buyer holds FXRP.
    // Redemption fees: FXRP burned ≥ requestedAmount + slack (caller covers fees by
    // burning slightly more FXRP than the target RLUSD; here we surface the raw
    // amountFxrp = requestedAmount mapped to UBA — orchestrator adds fee buffer).
    if (requestedChain === 'xrpl-mainnet' && fxrp >= requestedAmount) {
      // requestedAmount is in 18-dec UBA for EVM RLUSD; XRPL RLUSD is 6-dec via XRPL token.
      // Caller's orchestrator handles the unit conversion + fee buffer; here we pass
      // the raw amount through as amountFxrp (UBA) for protocol redemption.
      const xrplDestination = (input.xrplHoldings as unknown as { destination?: string })?.destination
        ?? 'rXrplDestinationFromAgent'; // orchestrator overrides with real address
      return {
        kind: 'xrpfi-redeem-then-swap',
        amountFxrp: requestedAmount,
        xrplDestination,
        expectedRlusdXrpl: requestedAmount,
      };
    }

    // Step 2.5b — reverse + bridge: same condition, but the request is on EVM and we have FXRP.
    // Active only when XRPL is in NTT_RLUSD_CHAINS (registry update unlocks this lane).
    if (
      input.allowReverseBridge
      && NTT_RLUSD_CHAINS.has(requestedChain)
      && NTT_RLUSD_CHAINS.has('xrpl-mainnet' as ChainKey) // gate on future registry add
      && fxrp >= requestedAmount
    ) {
      return {
        kind: 'xrpfi-redeem-swap-then-bridge',
        amountFxrp: requestedAmount,
        xrplDestination: 'rXrplDestinationFromAgent',
        bridgeToChain: requestedChain,
        bridgeAmount: requestedAmount,
      };
    }

    // Step 2.6 — forward partial: reqChain = EVM, buyer holds only XRP-XRPL.
    // SDK delivers FXRP on Flare; merchant payment requires Flare-NTT (v0.23+).
    if (NTT_RLUSD_CHAINS.has(requestedChain) && xrpDrops >= requestedAmount && fxrp === 0n) {
      const noEvmHoldings = NTT_SOURCE_PRIORITY.every(
        (k) => (buyerHoldings[k] ?? 0n) < requestedAmount,
      );
      if (noEvmHoldings) {
        return {
          kind: 'xrpfi-mint-fxrp',
          amountXrp: requestedAmount,
          stopChain: 'flare-mainnet',
        };
      }
    }
  }

  // Step 3: no route
  const suggestedFunding: ChainKey[] = [requestedChain];
  if (NTT_RLUSD_CHAINS.has(requestedChain)) {
    for (const c of NTT_SOURCE_PRIORITY) if (c !== requestedChain) suggestedFunding.push(c);
  }
  if (input.allowXrpfi) {
    suggestedFunding.push('xrpl-mainnet');
    suggestedFunding.push('flare-mainnet');
  }
  return {
    kind: 'no-route',
    reason: `No source chain has ${requestedAmount} RLUSD available with bridgeable lane to ${requestedChain}`,
    suggestedFunding,
  };
}
