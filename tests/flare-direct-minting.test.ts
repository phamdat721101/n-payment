import { describe, it, expect, vi } from 'vitest';
import { NPaymentError } from '../src/errors.js';
import { FlareClient } from '../src/flare/client.js';
import {
  parseXrpDropsAmount,
  formatXrpDropsAmount,
  computeDirectMintingQuote,
  encodeDirectMintingMemo32,
  toXrplMemoHex,
  getDirectMintingFees,
  getDirectMintingPaymentAddress,
  preflightDirectMintingLimits,
  DIRECT_MINTING_MEMO_PREFIX,
} from '../src/flare/direct-minting.js';

const ASSET_MANAGER = '0x1111111111111111111111111111111111111111';

function makeClient(routes: Record<string, unknown | (() => unknown)>): FlareClient {
  const readContract = vi.fn(async (req: { address: string; functionName: string }) => {
    const key = `${req.address.toLowerCase()}::${req.functionName}`;
    const handler = routes[key];
    if (handler === undefined) throw new Error(`unmocked: ${key}`);
    return typeof handler === 'function' ? (handler as () => unknown)() : handler;
  });
  const client = new FlareClient({ publicClient: { readContract } as never });
  (client.registry as unknown as { cache: Map<string, { address: string; expiresAt: number }> })
    .cache.set('AssetManagerFXRP', { address: ASSET_MANAGER, expiresAt: Date.now() + 1e9 });
  return client;
}

describe('parseXrpDropsAmount / formatXrpDropsAmount', () => {
  it.each([
    ['1', 1_000_000n],
    ['10', 10_000_000n],
    ['10.123456', 10_123_456n],
    ['0.000001', 1n],
  ])('parses %s → %s', (s, u) => {
    expect(parseXrpDropsAmount(s)).toBe(u);
  });

  it('rejects zero, negatives, scientific notation, over-precision', () => {
    for (const bad of ['0', '0.0', '-1', '1e3', '1.0000001', '', 'NaN']) {
      expect(() => parseXrpDropsAmount(bad)).toThrow(NPaymentError);
    }
  });

  it('round-trips through format', () => {
    for (const s of ['1', '10.5', '0.000001', '12345.123456']) {
      expect(formatXrpDropsAmount(parseXrpDropsAmount(s))).toBe(s);
    }
  });
});

describe('computeDirectMintingQuote', () => {
  it('matches the cross-chain-mint fee maths (10 XRP net → 10.4 XRP gross at 2% bps + 0.2 XRP exec)', () => {
    // bps=200 (2%), minFee=0, executorFee=0.2 XRP → 10 + 0.2 (proportional) + 0.2 (executor) = 10.4 XRP.
    const q = computeDirectMintingQuote('10', {
      feeBips: 200n,
      minFeeUBA: 0n,
      executorFeeUBA: 200_000n,
    });
    expect(q.netFxrp).toBe('10');
    expect(q.paymentXrp).toBe('10.4');
    expect(q.totalUBA).toBe(10_400_000n);
    expect(q.proportionalFeeUBA).toBe(200_000n);
    expect(q.mintingFeeUBA).toBe(200_000n);
  });

  it('applies the minimum-fee floor when proportional < min', () => {
    const q = computeDirectMintingQuote('1', {
      feeBips: 100n, // 1% of 1 XRP = 10_000 UBA
      minFeeUBA: 50_000n, // 0.05 XRP floor wins
      executorFeeUBA: 100_000n,
    });
    expect(q.mintingFeeUBA).toBe(50_000n);
    expect(q.totalUBA).toBe(1_000_000n + 50_000n + 100_000n);
  });

  it('uses the proportional fee when above the minimum floor', () => {
    const q = computeDirectMintingQuote('100', {
      feeBips: 100n, // 1% of 100 XRP = 1_000_000 UBA
      minFeeUBA: 50_000n,
      executorFeeUBA: 0n,
    });
    expect(q.mintingFeeUBA).toBe(1_000_000n);
  });
});

describe('encodeDirectMintingMemo32 / toXrplMemoHex', () => {
  it('is exactly 32 bytes', () => {
    const bytes = encodeDirectMintingMemo32('0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9F');
    expect(bytes.length).toBe(32);
  });

  it('produces the documented prefix + 4 zero bytes + lowercase recipient (golden vector)', () => {
    const hex = toXrplMemoHex(
      encodeDirectMintingMemo32('0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9F'),
    );
    expect(hex).toBe(
      (DIRECT_MINTING_MEMO_PREFIX + '00000000' + 'fd2f0eb6b9fa4fe5bb1f7b26fee3c647ed103d9f').toUpperCase(),
    );
    expect(hex.length).toBe(64);
  });

  it.each([
    '0x12',
    '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    'Fd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9F', // no 0x
    '0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9', // 19 bytes
    '0xFd2f0eb6b9fA4FE5bb1F7B26fEE3c647ed103d9FF', // 21 bytes
  ])('rejects %s', (bad) => {
    expect(() => encodeDirectMintingMemo32(bad as `0x${string}`)).toThrow(NPaymentError);
  });
});

describe('getDirectMintingFees', () => {
  it('reads (bips, min, executor) in parallel', async () => {
    const client = makeClient({
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingFeeBIPS`]: 200n,
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingMinimumFeeUBA`]: 100_000n,
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingExecutorFeeUBA`]: 200_000n,
    });
    const fees = await getDirectMintingFees(client);
    expect(fees).toEqual({ feeBips: 200n, minFeeUBA: 100_000n, executorFeeUBA: 200_000n });
  });

  it('wraps RPC errors as FLARE_FEE_READ_FAILED', async () => {
    const client = makeClient({
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingFeeBIPS`]: () => {
        throw new Error('rpc down');
      },
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingMinimumFeeUBA`]: 0n,
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingExecutorFeeUBA`]: 0n,
    });
    await expect(getDirectMintingFees(client)).rejects.toMatchObject({
      code: 'FLARE_FEE_READ_FAILED',
    });
  });
});

describe('getDirectMintingPaymentAddress', () => {
  it('returns the Core Vault XRPL classic address', async () => {
    const client = makeClient({
      [`${ASSET_MANAGER.toLowerCase()}::directMintingPaymentAddress`]: 'rCoreVault123',
    });
    expect(await getDirectMintingPaymentAddress(client)).toBe('rCoreVault123');
  });

  it('wraps RPC errors as FLARE_CORE_VAULT_RESOLUTION_FAILED', async () => {
    const client = makeClient({
      [`${ASSET_MANAGER.toLowerCase()}::directMintingPaymentAddress`]: () => {
        throw new Error('boom');
      },
    });
    await expect(getDirectMintingPaymentAddress(client)).rejects.toMatchObject({
      code: 'FLARE_CORE_VAULT_RESOLUTION_FAILED',
    });
  });
});

describe('preflightDirectMintingLimits', () => {
  it('flags totalUBA above the threshold as large', async () => {
    const client = makeClient({
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingLargeMintingThresholdUBA`]: 1_000_000n,
    });
    const r = await preflightDirectMintingLimits(client, 5_000_000n);
    expect(r.large).toBe(true);
    expect(r.largeThresholdUBA).toBe(1_000_000n);
  });

  it('returns benign defaults when the threshold function is missing', async () => {
    const client = makeClient({
      [`${ASSET_MANAGER.toLowerCase()}::getDirectMintingLargeMintingThresholdUBA`]: () => {
        throw new Error('not implemented');
      },
    });
    expect(await preflightDirectMintingLimits(client, 5_000_000n)).toEqual({
      large: false,
      largeThresholdUBA: null,
    });
  });
});
