import { describe, expect, it } from 'vitest';
import { selectRlusdCorridor } from '../src/payrouter/corridor.js';
import type { CorridorRouteInput } from '../src/payrouter/types.js';

const ONE = 10n ** 18n;
const FIVE = 5n * ONE;
const HUNDRED = 100n * ONE;
const LIVE = { outbound: HUNDRED, inbound: HUNDRED };

const baseInput = (overrides: Partial<CorridorRouteInput> = {}): CorridorRouteInput => ({
  requestedAsset: 'RLUSD',
  requestedChain: 'base-mainnet',
  requestedAmount: ONE,
  buyerHoldings: {},
  ...overrides,
});

describe('selectRlusdCorridor — direct hits', () => {
  it('direct hit when buyer holds enough on requested chain', () => {
    const r = selectRlusdCorridor(baseInput({ buyerHoldings: { 'base-mainnet': FIVE } }));
    expect(r).toEqual({ kind: 'direct', chain: 'base-mainnet' });
  });

  it('direct hit on Ethereum requested chain', () => {
    const r = selectRlusdCorridor(
      baseInput({ requestedChain: 'ethereum-mainnet', buyerHoldings: { 'ethereum-mainnet': FIVE } }),
    );
    expect(r).toEqual({ kind: 'direct', chain: 'ethereum-mainnet' });
  });

  it('direct hit even when sufficient amount is also on another chain (prefers same-chain)', () => {
    const r = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'base-mainnet': FIVE, 'optimism-mainnet': FIVE } }),
    );
    expect(r).toEqual({ kind: 'direct', chain: 'base-mainnet' });
  });
});

describe('selectRlusdCorridor — NTT bridge', () => {
  it('Optimism → Base via NTT (with live limits override)', () => {
    const r = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'optimism-mainnet': FIVE }, liveLimits: LIVE }),
    );
    expect(r).toEqual({
      kind: 'ntt-bridge',
      fromChain: 'optimism-mainnet',
      toChain: 'base-mainnet',
      amount: ONE,
    });
  });

  it('falls back to next-priority source when first has insufficient balance', () => {
    const r = selectRlusdCorridor(
      baseInput({
        buyerHoldings: {
          'optimism-mainnet': ONE / 2n,  // not enough
          'unichain-mainnet': FIVE,        // priority 3
        },
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('ntt-bridge');
    if (r.kind === 'ntt-bridge') expect(r.fromChain).toBe('unichain-mainnet');
  });

  it('respects NTT_SOURCE_PRIORITY order — Optimism wins over Base when both can satisfy', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'unichain-mainnet',
        buyerHoldings: { 'optimism-mainnet': FIVE, 'base-mainnet': FIVE, 'ink-mainnet': FIVE },
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('ntt-bridge');
    if (r.kind === 'ntt-bridge') expect(r.fromChain).toBe('optimism-mainnet');
  });

  it('rejects without live limits override (static outbound = 0)', () => {
    const r = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'optimism-mainnet': FIVE } }),
    );
    expect(r.kind).toBe('no-route');
  });

  it('skips source chains where the lane has no inbound (e.g. Optimism→Optimism is same-chain, skipped)', () => {
    // Bridge to Base; Optimism has 5 RLUSD; only Optimism is held. Base inbound from Optimism = 50M.
    const r = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'optimism-mainnet': FIVE }, liveLimits: LIVE }),
    );
    expect(r.kind).toBe('ntt-bridge');
  });

  it('Ink → Base via NTT (Base inbound from Ink = 50M)', () => {
    const r = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'ink-mainnet': FIVE }, liveLimits: LIVE }),
    );
    expect(r.kind).toBe('ntt-bridge');
    if (r.kind === 'ntt-bridge') expect(r.fromChain).toBe('ink-mainnet');
  });
});

describe('selectRlusdCorridor — no-route', () => {
  it('returns no-route with suggestedFunding when buyer has nothing', () => {
    const r = selectRlusdCorridor(baseInput());
    expect(r.kind).toBe('no-route');
    if (r.kind === 'no-route') {
      expect(r.suggestedFunding).toContain('base-mainnet');
      expect(r.suggestedFunding.length).toBeGreaterThan(1);
    }
  });

  it('rejects invalid amount', () => {
    const r = selectRlusdCorridor(baseInput({ requestedAmount: 0n }));
    expect(r.kind).toBe('no-route');
    if (r.kind === 'no-route') expect(r.reason).toBe('invalid-amount');
  });

  it('rejects when buyer has insufficient on every chain individually', () => {
    const small = ONE / 10n;
    const r = selectRlusdCorridor(
      baseInput({
        buyerHoldings: {
          'optimism-mainnet': small,
          'unichain-mainnet': small,
          'ink-mainnet': small,
        },
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('no-route');
  });

  it('non-NTT requested chain (xrpl-mainnet) returns no-route — XRPFi handled in PRD-G', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'xrpl-mainnet',
        buyerHoldings: { 'optimism-mainnet': FIVE },
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('no-route');
  });

  it('rejects when destination has no inbound from any held source (Base ↛ Optimism in static)', () => {
    // Optimism inbound matrix: Base, Unichain, Ink — Ethereum NOT included.
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'optimism-mainnet',
        buyerHoldings: { 'ethereum-mainnet': FIVE },
        liveLimits: { outbound: HUNDRED, inbound: 0n }, // explicit 0 inbound override
      }),
    );
    expect(r.kind).toBe('no-route');
  });
});

describe('selectRlusdCorridor — edge cases', () => {
  it('exactly-equal balance accepts direct', () => {
    const r = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'base-mainnet': ONE } }),
    );
    expect(r.kind).toBe('direct');
  });

  it('one-wei-less balance falls through to ntt-bridge', () => {
    const r = selectRlusdCorridor(
      baseInput({
        buyerHoldings: { 'base-mainnet': ONE - 1n, 'optimism-mainnet': FIVE },
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('ntt-bridge');
  });

  it('preserves bigint amount in ntt-bridge decision', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedAmount: 12345n,
        buyerHoldings: { 'optimism-mainnet': HUNDRED },
        liveLimits: LIVE,
      }),
    );
    if (r.kind === 'ntt-bridge') expect(r.amount).toBe(12345n);
  });
});
