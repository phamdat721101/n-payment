import { describe, it, expect } from 'vitest';
import { NPaymentError } from '../src/errors.js';
import {
  RLUSD_ISSUERS,
  getRlusdIssuer,
  networkFromChainKey,
  parseRlusdAmount,
  formatRlusdAmount,
  padSendMaxDrops,
  computeQuoteSlippageBps,
} from '../src/xrpl/utils.js';

describe('RLUSD issuer registry', () => {
  it('mainnet and testnet issuers differ (per Ripple docs)', () => {
    expect(getRlusdIssuer('mainnet')).toBe('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De');
    expect(getRlusdIssuer('testnet')).toBe('rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV');
    expect(RLUSD_ISSUERS.mainnet).not.toBe(RLUSD_ISSUERS.testnet);
  });

  it('networkFromChainKey maps chain keys correctly', () => {
    expect(networkFromChainKey('xrpl-mainnet')).toBe('mainnet');
    expect(networkFromChainKey('xrpl-testnet')).toBe('testnet');
    expect(networkFromChainKey('unknown' as never)).toBe('testnet'); // safe default
  });
});

describe('parseRlusdAmount', () => {
  it.each([
    ['0', 0n],
    ['1', 1_000_000n],
    ['5.123456', 5_123_456n],
    ['0.000001', 1n],
    ['1000', 1_000_000_000n],
    ['12.5', 12_500_000n],
  ])('parses %s → %s units', (input, expected) => {
    expect(parseRlusdAmount(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['1.0e3', 'scientific notation'],
    ['-5', 'negative'],
    ['5.1234567', 'over-precision'],
    ['NaN', 'NaN literal'],
    ['1,000', 'thousands separator'],
    ['1.', 'trailing dot'],
  ])('rejects %s (%s)', (input) => {
    expect(() => parseRlusdAmount(input)).toThrow(NPaymentError);
  });
});

describe('formatRlusdAmount', () => {
  it.each([
    [0n, '0'],
    [1_000_000n, '1'],
    [5_123_456n, '5.123456'],
    [1n, '0.000001'],
    [12_500_000n, '12.5'],
  ])('formats %s → %s', (input, expected) => {
    expect(formatRlusdAmount(input)).toBe(expected);
  });

  it('round-trips with parseRlusdAmount', () => {
    for (const sample of ['0', '1', '5.123456', '0.000001', '12.5']) {
      expect(formatRlusdAmount(parseRlusdAmount(sample))).toBe(sample);
    }
  });

  it('rejects negative inputs', () => {
    expect(() => formatRlusdAmount(-1n)).toThrow(NPaymentError);
  });
});

describe('padSendMaxDrops', () => {
  it('always rounds up — never under-funds the swap', () => {
    // 12,450,000 drops × 1.01 = 12,574,500 (exact)
    expect(padSendMaxDrops(12_450_000n, 100)).toBe(12_574_500n);
    // For 1 bps over an odd value, must round up not down.
    expect(padSendMaxDrops(99_999n, 1)).toBe(100_009n); // ceil(99999*10001/10000)
  });

  it('zero slippage = identity', () => {
    expect(padSendMaxDrops(1_234_567n, 0)).toBe(1_234_567n);
  });

  it('rejects out-of-range slippage', () => {
    expect(() => padSendMaxDrops(1n, -1)).toThrow(NPaymentError);
    expect(() => padSendMaxDrops(1n, 5001)).toThrow(NPaymentError);
    expect(() => padSendMaxDrops(1n, 1.5)).toThrow(NPaymentError);
  });
});

describe('computeQuoteSlippageBps', () => {
  it('returns 0 when quote ≤ expected', () => {
    expect(computeQuoteSlippageBps(1_000_000n, 1_000_000n, 1)).toBe(0);
  });

  it('returns ~100 bps when quote is 1% over expected', () => {
    // expected = 10_000_000n (10 RLUSD × 1 drop/unit), quote = 10_100_000n
    const bps = computeQuoteSlippageBps(10_100_000n, 10_000_000n, 1);
    expect(bps).toBe(100);
  });

  it('handles degenerate inputs without dividing by zero', () => {
    expect(computeQuoteSlippageBps(0n, 0n, 0)).toBe(0);
    expect(computeQuoteSlippageBps(1_000_000n, 1_000_000n, 0)).toBe(0);
  });
});
