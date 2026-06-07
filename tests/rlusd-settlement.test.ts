import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _clearRlusdIdempotencyCache,
  decodeRlusdExactPayment,
  verifyExactRlusdPayment,
  verifyWormholeNttPayment,
  type RlusdRpcClient,
} from '../src/middleware.js';

const MERCHANT = '0x1234567890123456789012345678901234567890' as const;
const BUYER = '0xabcdef0123456789abcdef0123456789abcdef01' as const;
const RLUSD_BASE = '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258' as const;
const TX_HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

const padAddrTopic = (addr: string) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();

const oneRlusd = 10n ** 18n;

const proofExact = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      scheme: 'exact',
      network: 'eip155:8453',
      txHash: TX_HASH,
      from: BUYER,
      to: MERCHANT,
      value: oneRlusd.toString(),
      asset: RLUSD_BASE,
      ...overrides,
    }),
  ).toString('base64');

const proofNtt = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      scheme: 'wormhole-ntt-transfer',
      destNetwork: 'eip155:8453',
      destTxHash: TX_HASH,
      vaa: 'AAAA',
      srcChain: 'Optimism',
      srcTxHash: '0x2222',
      ...overrides,
    }),
  ).toString('base64');

const stubRpc = (overrides: {
  status?: 'success' | 'reverted';
  blockAge?: bigint;
  logs?: Array<{ address: string; topics: readonly string[]; data: string }>;
  receipt?: null;
} = {}): RlusdRpcClient => {
  const status = overrides.status ?? 'success';
  const tipBlock = 1_000_000n;
  const blockNumber = tipBlock - (overrides.blockAge ?? 1n);
  return {
    async getTransactionReceipt() {
      if (overrides.receipt === null) return null;
      return {
        status,
        blockNumber,
        logs: overrides.logs ?? [
          {
            address: RLUSD_BASE,
            topics: [
              ERC20_TRANSFER_TOPIC,
              padAddrTopic(BUYER),
              padAddrTopic(MERCHANT),
            ],
            data: '0x' + oneRlusd.toString(16).padStart(64, '0'),
          },
        ],
      };
    },
    async getBlockNumber() {
      return tipBlock;
    },
  };
};

beforeEach(() => _clearRlusdIdempotencyCache());
afterEach(() => _clearRlusdIdempotencyCache());

describe('decodeRlusdExactPayment', () => {
  it('decodes a valid exact payload', () => {
    const r = decodeRlusdExactPayment(proofExact());
    expect(r?.scheme).toBe('exact');
    expect(r?.txHash).toBe(TX_HASH);
  });

  it('returns null for malformed base64', () => {
    expect(decodeRlusdExactPayment('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for wrong scheme', () => {
    expect(decodeRlusdExactPayment(proofExact({ scheme: 'eip3009' }))).toBeNull();
  });
});

describe('verifyExactRlusdPayment', () => {
  it('accepts a confirmed Transfer log matching from/to/value/asset', async () => {
    const r = await verifyExactRlusdPayment({
      headerVal: proofExact(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc(),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unconfirmed tx (receipt null)', async () => {
    const r = await verifyExactRlusdPayment({
      headerVal: proofExact(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc({ receipt: null }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tx-not-confirmed');
  });

  it('rejects reverted tx', async () => {
    const r = await verifyExactRlusdPayment({
      headerVal: proofExact(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc({ status: 'reverted' }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tx-reverted');
  });

  it('rejects too-old tx', async () => {
    const r = await verifyExactRlusdPayment({
      headerVal: proofExact(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc({ blockAge: 9999n }),
      maxBlockAge: 100n,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tx-too-old');
  });

  it('rejects mismatched asset', async () => {
    const r = await verifyExactRlusdPayment({
      headerVal: proofExact(),
      expectedAsset: '0xdeadbeef00000000000000000000000000000000',
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('transfer-log-missing-or-mismatch');
  });

  it('rejects under-value transfer', async () => {
    const r = await verifyExactRlusdPayment({
      headerVal: proofExact(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd * 10n,
      rpc: stubRpc(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('transfer-log-missing-or-mismatch');
  });

  it('idempotency: rejects already-consumed tx', async () => {
    const params = {
      headerVal: proofExact(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc(),
    };
    const first = await verifyExactRlusdPayment(params);
    expect(first.ok).toBe(true);
    const second = await verifyExactRlusdPayment(params);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('tx-already-consumed');
  });
});

describe('verifyWormholeNttPayment', () => {
  it('accepts redemption mint to merchant for correct amount (Transfer from 0x0)', async () => {
    const mintLog = [
      {
        address: RLUSD_BASE,
        topics: [ERC20_TRANSFER_TOPIC, ZERO_TOPIC, padAddrTopic(MERCHANT)],
        data: '0x' + oneRlusd.toString(16).padStart(64, '0'),
      },
    ];
    const r = await verifyWormholeNttPayment({
      headerVal: proofNtt(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc({ logs: mintLog }),
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when mint event absent (regular Transfer not from 0x0)', async () => {
    const r = await verifyWormholeNttPayment({
      headerVal: proofNtt(),
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc(), // default stub uses non-zero from-address
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('redemption-log-missing-or-mismatch');
  });

  it('rejects wrong scheme', async () => {
    const r = await verifyWormholeNttPayment({
      headerVal: proofExact(), // exact scheme, not ntt
      expectedAsset: RLUSD_BASE,
      expectedTo: MERCHANT,
      expectedMinValue: oneRlusd,
      rpc: stubRpc(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-scheme-or-missing-dest-tx');
  });
});
