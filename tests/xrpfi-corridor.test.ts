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

describe('selectRlusdCorridor — XRPFi (allowXrpfi=true)', () => {
  it('reverse: FXRP → XRPL-RLUSD when reqChain=xrpl-mainnet and buyer holds FXRP', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'xrpl-mainnet',
        flareHoldings: { fxrp: FIVE },
        allowXrpfi: true,
      }),
    );
    expect(r.kind).toBe('xrpfi-redeem-then-swap');
    if (r.kind === 'xrpfi-redeem-then-swap') {
      expect(r.amountFxrp).toBe(ONE);
      expect(r.expectedRlusdXrpl).toBe(ONE);
    }
  });

  it('forward partial: reqChain=EVM and only XRP-XRPL holdings → xrpfi-mint-fxrp', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'base-mainnet',
        xrplHoldings: { xrpDrops: FIVE },
        flareHoldings: { fxrp: 0n },
        allowXrpfi: true,
      }),
    );
    expect(r.kind).toBe('xrpfi-mint-fxrp');
    if (r.kind === 'xrpfi-mint-fxrp') {
      expect(r.amountXrp).toBe(ONE);
      expect(r.stopChain).toBe('flare-mainnet');
    }
  });

  it('forward partial: skipped when buyer also holds RLUSD on an EVM source', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'base-mainnet',
        xrplHoldings: { xrpDrops: FIVE },
        buyerHoldings: { 'optimism-mainnet': FIVE },
        allowXrpfi: true,
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('ntt-bridge'); // direct EVM path wins
  });

  it('reverse-bridge is not emitted today (XRPL not in NTT registry)', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'base-mainnet',
        flareHoldings: { fxrp: FIVE },
        allowXrpfi: true,
        allowReverseBridge: true,
      }),
    );
    // Falls through to no-route since XRPL is not in NTT_RLUSD_CHAINS today.
    expect(r.kind).toBe('no-route');
  });

  it('XRPFi disabled (default) — XRPL request with FXRP held returns no-route', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'xrpl-mainnet',
        flareHoldings: { fxrp: FIVE },
        // allowXrpfi defaults false
      }),
    );
    expect(r.kind).toBe('no-route');
  });

  it('XRPFi enabled but insufficient FXRP — no-route', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'xrpl-mainnet',
        flareHoldings: { fxrp: ONE / 10n },
        allowXrpfi: true,
      }),
    );
    expect(r.kind).toBe('no-route');
  });

  it('reverse: reqChain=xrpl-mainnet but buyer also has direct RLUSD-XRPL → direct wins', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'xrpl-mainnet',
        buyerHoldings: { 'xrpl-mainnet': FIVE },
        flareHoldings: { fxrp: FIVE },
        allowXrpfi: true,
      }),
    );
    expect(r.kind).toBe('direct');
  });

  it('no-route includes xrpl-mainnet + flare-mainnet in suggestedFunding when allowXrpfi=true', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'base-mainnet',
        allowXrpfi: true,
      }),
    );
    expect(r.kind).toBe('no-route');
    if (r.kind === 'no-route') {
      expect(r.suggestedFunding).toContain('xrpl-mainnet');
      expect(r.suggestedFunding).toContain('flare-mainnet');
    }
  });

  it('back-compat: allowXrpfi=false produces same decision as v0.22.0', () => {
    const r1 = selectRlusdCorridor(
      baseInput({ buyerHoldings: { 'base-mainnet': FIVE } }),
    );
    const r2 = selectRlusdCorridor(
      baseInput({
        buyerHoldings: { 'base-mainnet': FIVE },
        flareHoldings: { fxrp: HUNDRED },
        xrplHoldings: { xrpDrops: HUNDRED },
        allowXrpfi: false,
      }),
    );
    expect(r1).toEqual(r2);
  });

  it('reverse: requested amount preserved through decision', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'xrpl-mainnet',
        requestedAmount: 12345n,
        flareHoldings: { fxrp: HUNDRED },
        allowXrpfi: true,
      }),
    );
    if (r.kind === 'xrpfi-redeem-then-swap') {
      expect(r.amountFxrp).toBe(12345n);
    }
  });

  it('priority: NTT-bridge wins over XRPFi reverse when both possible', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'base-mainnet',
        buyerHoldings: { 'optimism-mainnet': FIVE },
        flareHoldings: { fxrp: FIVE },
        allowXrpfi: true,
        allowReverseBridge: true,
        liveLimits: LIVE,
      }),
    );
    expect(r.kind).toBe('ntt-bridge');
  });

  it('forward: stopChain is always flare-mainnet (informative)', () => {
    const r = selectRlusdCorridor(
      baseInput({
        requestedChain: 'optimism-mainnet',
        xrplHoldings: { xrpDrops: FIVE },
        allowXrpfi: true,
      }),
    );
    if (r.kind === 'xrpfi-mint-fxrp') {
      expect(r.stopChain).toBe('flare-mainnet');
    } else {
      throw new Error('Expected xrpfi-mint-fxrp decision');
    }
  });
});
