import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  STELLAR_ASSETS,
  STELLAR_ASSET_SYMBOLS,
  MGUSD_ISSUER_PLACEHOLDER,
  getStellarAsset,
  parseStellarAsset,
  formatStellarAsset,
  assertVerifiedIssuer,
} from '../src/stellar/assets.js';

describe('STELLAR_ASSETS registry (v0.21)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. contains exactly USDC, EURC, MGUSD (curated set)', () => {
    expect(STELLAR_ASSET_SYMBOLS.sort()).toEqual(['EURC', 'MGUSD', 'USDC']);
    expect(STELLAR_ASSETS.USDC.verified).toBe(true);
    expect(STELLAR_ASSETS.EURC.verified).toBe(true);
    expect(STELLAR_ASSETS.MGUSD.verified).toBe(false);
  });

  it('2. getStellarAsset is case-insensitive', () => {
    expect(getStellarAsset('mgusd').code).toBe('MGUSD');
    expect(getStellarAsset('Usdc').code).toBe('USDC');
  });

  it('3. unknown symbol throws STELLAR_ASSET_UNKNOWN with hint listing known symbols', () => {
    try {
      getStellarAsset('FOOBAR');
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as { code: string; hint?: string };
      expect(e.code).toBe('STELLAR_ASSET_UNKNOWN');
      expect(e.hint).toContain('USDC');
      expect(e.hint).toContain('MGUSD');
    }
  });

  it('4. parseStellarAsset 1.5 MGUSD → 15_000_000n (7 decimals)', () => {
    expect(parseStellarAsset('1.5', 'MGUSD')).toBe(15_000_000n);
    expect(parseStellarAsset(1.5, 'MGUSD')).toBe(15_000_000n);
  });

  it('5. parseStellarAsset truncates excess fractional digits', () => {
    expect(parseStellarAsset('1.50000001', 'MGUSD')).toBe(15_000_000n);
    expect(parseStellarAsset('0.123456789', 'MGUSD')).toBe(1_234_567n);
  });

  it('6. parseStellarAsset rejects invalid amount', () => {
    expect(() => parseStellarAsset('abc', 'MGUSD')).toThrowError(/STELLAR_ASSET_INVALID_AMOUNT|Invalid amount/);
    expect(() => parseStellarAsset('-1.5', 'MGUSD')).toThrowError(/STELLAR_ASSET_INVALID_AMOUNT|Invalid amount/);
    expect(() => parseStellarAsset('1.5e2', 'MGUSD')).toThrowError(/STELLAR_ASSET_INVALID_AMOUNT|Invalid amount/);
  });

  it('7. formatStellarAsset truncates to displayDecimals', () => {
    expect(formatStellarAsset(15_000_000n, 'MGUSD', 2)).toBe('1.50');
    expect(formatStellarAsset(15_000_000n, 'MGUSD', 4)).toBe('1.5000');
    expect(formatStellarAsset(0n, 'MGUSD', 2)).toBe('0.00');
  });

  it('8. formatStellarAsset with displayDecimals=0 returns whole', () => {
    expect(formatStellarAsset(15_000_000n, 'MGUSD', 0)).toBe('1');
    expect(formatStellarAsset(35_700_000n, 'USDC', 0)).toBe('3');
  });

  it('9. env override sets MGUSD issuer at call time (test isolation)', () => {
    process.env.STELLAR_MGUSD_ISSUER = 'GBRIDGEPLACEHOLDER000000000000000000000000000000000000000';
    const asset = getStellarAsset('MGUSD');
    expect(asset.issuer).toBe('GBRIDGEPLACEHOLDER000000000000000000000000000000000000000');
    expect(asset.verified).toBe(true);
  });

  it('10. clearing env override restores placeholder', () => {
    process.env.STELLAR_MGUSD_ISSUER = 'GBRIDGEFOO000000000000000000000000000000000000000000000000';
    expect(getStellarAsset('MGUSD').issuer).toBe('GBRIDGEFOO000000000000000000000000000000000000000000000000');
    delete process.env.STELLAR_MGUSD_ISSUER;
    expect(getStellarAsset('MGUSD').issuer).toBe(MGUSD_ISSUER_PLACEHOLDER);
    expect(getStellarAsset('MGUSD').verified).toBe(false);
  });

  it('11. assertVerifiedIssuer warns once per asset for placeholders', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    delete process.env.STELLAR_MGUSD_ISSUER;
    const asset = getStellarAsset('MGUSD');
    assertVerifiedIssuer(asset);
    assertVerifiedIssuer(asset); // second call should not warn again
    // verified asset → no warn
    assertVerifiedIssuer(getStellarAsset('USDC'));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('STELLAR_ASSET_PLACEHOLDER_ISSUER');
    warnSpy.mockRestore();
  });

  it('12. parse + format round-trip preserves value at displayDecimals=4', () => {
    const original = '1.2345';
    const parsed = parseStellarAsset(original, 'MGUSD');
    expect(formatStellarAsset(parsed, 'MGUSD', 4)).toBe('1.2345');
  });
});
