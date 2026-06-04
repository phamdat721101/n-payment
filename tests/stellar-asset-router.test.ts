import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  selectAsset,
  findStellarAmmPath,
  CORRIDOR_PREFERENCE,
} from '../src/stellar/asset-router.js';

describe('selectAsset (multi-stable PayRouter v2)', () => {
  it('1. direct match: requested USDC, buyer holds USDC → kind:direct USDC', () => {
    const r = selectAsset({ requested: 'USDC', buyerHoldings: ['USDC'] });
    expect(r).toEqual({ kind: 'direct', asset: 'USDC' });
  });

  it('2. direct match wins over corridor: requested MGUSD, buyer holds MGUSD + USDC → MGUSD', () => {
    const r = selectAsset({
      requested: 'MGUSD',
      buyerHoldings: ['MGUSD', 'USDC'],
      corridor: 'us-domestic', // corridor prefers USDC, but direct hit wins
    });
    expect(r.kind).toBe('direct');
    if (r.kind === 'direct') expect(r.asset).toBe('MGUSD');
  });

  it('3. no auto-convert + no direct match → kind:no-route with suggestedFunding', () => {
    const r = selectAsset({
      requested: 'MGUSD',
      buyerHoldings: ['USDC'],
      // allowAutoConvert defaults false
    });
    expect(r.kind).toBe('no-route');
    if (r.kind === 'no-route') {
      expect(r.suggestedFunding[0]).toBe('MGUSD');
      expect(r.reason).toMatch(/Buyer holds .*USDC.*; seller wants MGUSD/);
    }
  });

  it('4. auto-convert: requested MGUSD, buyer holds USDC, allowAutoConvert → from USDC to MGUSD', () => {
    const r = selectAsset({
      requested: 'MGUSD',
      buyerHoldings: ['USDC'],
      allowAutoConvert: true,
    });
    expect(r).toEqual({
      kind: 'auto-convert',
      from: 'USDC',
      to: 'MGUSD',
      via: 'stellar-amm',
      estimatedSlippageBps: 30,
    });
  });

  it('5. corridor heuristic surfaces in auto-convert tie-breaking', () => {
    // Buyer holds both EURC and USDC; us-mx prefers MGUSD, fallback USDC
    const r = selectAsset({
      requested: 'MGUSD',
      buyerHoldings: ['USDC', 'EURC'],
      corridor: 'us-mx',
      allowAutoConvert: true,
    });
    expect(r.kind).toBe('auto-convert');
    if (r.kind === 'auto-convert') {
      // us-mx preference is [MGUSD, USDC] — first held = USDC
      expect(r.from).toBe('USDC');
      expect(r.to).toBe('MGUSD');
    }
  });

  it('6. seller preference overrides corridor in auto-convert', () => {
    const r = selectAsset({
      requested: 'MGUSD',
      buyerHoldings: ['EURC'],
      corridor: 'us-mx', // would prefer USDC fallback, but buyer doesn't hold USDC
      sellerPreference: ['EURC'],
      allowAutoConvert: true,
    });
    expect(r.kind).toBe('auto-convert');
    if (r.kind === 'auto-convert') {
      expect(r.from).toBe('EURC');
      expect(r.to).toBe('MGUSD');
    }
  });

  it('7. suggestedFunding[0] === requested asset (UI prompts the right top-up)', () => {
    const r = selectAsset({ requested: 'MGUSD', buyerHoldings: [] });
    expect(r.kind).toBe('no-route');
    if (r.kind === 'no-route') expect(r.suggestedFunding[0]).toBe('MGUSD');
  });

  it('8. STELLAR_ASSET_UNKNOWN propagates from invalid symbol', () => {
    expect(() =>
      selectAsset({ requested: 'BTC' as never, buyerHoldings: ['USDC'] }),
    ).toThrowError(/STELLAR_ASSET_UNKNOWN|Unknown Stellar asset/);
  });

  it('9. mocked AMM null path → caller pattern (selectAsset returns auto-convert; findStellarAmmPath null)', async () => {
    // selectAsset itself doesn't call AMM (pure fn). We separately verify findStellarAmmPath returns null on no records.
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValueOnce(
      new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 }),
    );
    const path = await findStellarAmmPath('USDC', 'MGUSD', 1_000_000n, 'https://horizon-testnet.stellar.org');
    expect(path).toBeNull();
    fetchSpy.mockRestore();
  });

  it('10. estimatedSlippageBps default = 30', () => {
    const r = selectAsset({
      requested: 'MGUSD',
      buyerHoldings: ['USDC'],
      allowAutoConvert: true,
    });
    if (r.kind === 'auto-convert') expect(r.estimatedSlippageBps).toBe(30);
  });

  it('11. all 9 corridor preferences are non-empty arrays of valid symbols', () => {
    for (const corridor of Object.keys(CORRIDOR_PREFERENCE)) {
      const list = CORRIDOR_PREFERENCE[corridor as keyof typeof CORRIDOR_PREFERENCE];
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      for (const sym of list) {
        expect(['USDC', 'EURC', 'MGUSD']).toContain(sym);
      }
    }
  });

  it('12. findStellarAmmPath returns a path with bounded slippage when records exist', async () => {
    const mockResponse = {
      _embedded: {
        records: [
          { source_amount: '1.0030000', destination_amount: '1.0000000', path: [] },
        ],
      },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockResolvedValueOnce(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );
    const path = await findStellarAmmPath('USDC', 'MGUSD', 10_000_000n, 'https://horizon-testnet.stellar.org', {
      maxSlippageBps: 50,
    });
    expect(path).not.toBeNull();
    if (path) {
      expect(path.minDestination).toBeLessThan(10_000_000n);
      expect(path.pathBps).toBeGreaterThanOrEqual(0);
      expect(path.pathBps).toBeLessThanOrEqual(50);
    }
    fetchSpy.mockRestore();
  });
});
