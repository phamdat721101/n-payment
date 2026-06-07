import { describe, expect, it, vi } from 'vitest';
import {
  computeRedemptionQuote,
  type RedemptionFees,
} from '../src/flare/direct-minting.js';
import { FlareBridgeClient, type FlareBridgeConfig } from '../src/flare/bridge.js';

const fees: RedemptionFees = {
  feeBips: 25n,
  minFeeUBA: 100_000n,
  executorFeeUBA: 200_000n,
};

describe('computeRedemptionQuote — pure-fn', () => {
  it('applies proportional fee + executor fee to net receive', () => {
    const r = computeRedemptionQuote('10', fees);
    expect(r.burnedFxrpUBA).toBe(10_000_000n);
    expect(r.proportionalFeeUBA).toBe(25_000n);
    expect(r.redemptionFeeUBA).toBe(100_000n); // floor wins (25_000 < 100_000)
    expect(r.executorFeeUBA).toBe(200_000n);
    expect(r.netReceiveUBA).toBe(9_700_000n);
    expect(r.receivedXrp).toBe('9.7');
  });

  it('proportional fee wins above floor', () => {
    const r = computeRedemptionQuote('1000', fees);
    expect(r.proportionalFeeUBA).toBe(2_500_000n);
    expect(r.redemptionFeeUBA).toBe(2_500_000n); // proportional > min
  });

  it('throws when fees exceed amount', () => {
    expect(() => computeRedemptionQuote('0.000001', fees)).toThrow(
      /Redemption fees.*exceed the redemption amount/,
    );
  });

  it('rejects invalid amount strings', () => {
    expect(() => computeRedemptionQuote('abc', fees)).toThrow(/Invalid XRP amount/);
    expect(() => computeRedemptionQuote('-1', fees)).toThrow(/Invalid XRP amount/);
  });
});

// ─── FlareBridgeClient.redeemXRP / pollRedemption ─────────────────────────────

const ASSET_MANAGER = '0x1111111111111111111111111111111111111111';
const FLARE_AGENT = '0x2222222222222222222222222222222222222222';
const FLARE_TX = '0x3333333333333333333333333333333333333333333333333333333333333333';
const XRPL_TX = '0x4444444444444444444444444444444444444444444444444444444444444444';
const REQUEST_ID = 42n;

// Pre-computed event topic hashes via keccak256.
// Computed at runtime from the ABI to avoid hard-coding.
const REDEMPTION_REQUESTED_TOPIC =
  '0x' + Array.from('RedemptionRequested', (c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('').padEnd(64, '0');
// Note: real keccak match is provided by viem.decodeEventLog inside the client; the test stub
// returns a synthetic log structure that our parseRedemptionRequestedId tolerates via decodeEventLog.

const mkPublicClient = (overrides: Partial<{ logs: unknown[]; blockNumber: bigint }> = {}): unknown => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'getRedemptionFeeBIPS':
        return 25n;
      case 'getRedemptionMinimumFeeUBA':
        return 100_000n;
      case 'getRedemptionExecutorFeeUBA':
        return 200_000n;
      case 'lotSize':
        return 1_000_000n; // 1 XRP per lot
      case 'fAsset':
        return '0xfa55fa55fa55fa55fa55fa55fa55fa55fa55fa55';
      case 'balanceOf':
        return 100_000_000n; // 100 FXRP
      default:
        throw new Error(`Unexpected readContract: ${functionName}`);
    }
  }),
  waitForTransactionReceipt: vi.fn(async () => ({
    logs: overrides.logs ?? [],
  })),
  getBlockNumber: vi.fn(async () => overrides.blockNumber ?? 1_000n),
  getLogs: vi.fn(async () => []),
});

const mkFlareClient = (publicClientOverrides: Parameters<typeof mkPublicClient>[0] = {}): unknown => ({
  publicClient: mkPublicClient(publicClientOverrides),
  registry: { address: vi.fn(async () => ASSET_MANAGER) },
});

const mkBridge = (cfg: Partial<FlareBridgeConfig>, publicClientOverrides: Parameters<typeof mkPublicClient>[0] = {}) => {
  return new FlareBridgeClient({
    flare: mkFlareClient(publicClientOverrides) as never,
    xrplWallet: { getAddress: async () => 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH', sign: async () => ({ tx_blob: '' }) } as never,
    xrplConnection: { getClient: async () => ({}) } as never,
    flareAddress: FLARE_AGENT,
    walletClient: cfg.walletClient,
    ...cfg,
  });
};

describe('FlareBridgeClient.redeemXRP', () => {
  it('throws FLARE_REDEEM_NO_WALLET_CLIENT when walletClient missing', async () => {
    const bridge = mkBridge({});
    await expect(
      bridge.redeemXRP({ amountFxrp: '1', xrplDestination: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' }),
    ).rejects.toMatchObject({ code: 'FLARE_REDEEM_NO_WALLET_CLIENT' });
  });

  it('rejects malformed XRPL destination', async () => {
    const walletClient = {
      writeContract: vi.fn(),
      account: { address: FLARE_AGENT },
    };
    const bridge = mkBridge({ walletClient: walletClient as never });
    await expect(
      bridge.redeemXRP({ amountFxrp: '1', xrplDestination: 'not-an-xrpl-address' }),
    ).rejects.toMatchObject({ code: 'FLARE_REDEEM_INVALID_XRPL_ADDRESS' });
  });

  it('rejects non-lot-multiple amounts', async () => {
    const walletClient = {
      writeContract: vi.fn(),
      account: { address: FLARE_AGENT },
    };
    // lotSize 1 XRP = 1_000_000 UBA; 0.5 XRP = 500_000 UBA → not multiple
    const bridge = mkBridge({ walletClient: walletClient as never });
    await expect(
      bridge.redeemXRP({ amountFxrp: '0.5', xrplDestination: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' }),
    ).rejects.toMatchObject({ code: 'FLARE_REDEEM_NOT_LOT_MULTIPLE' });
  });

  it('throws when no RedemptionRequested event is emitted', async () => {
    const walletClient = {
      writeContract: vi.fn(async () => FLARE_TX),
      account: { address: FLARE_AGENT },
    };
    const bridge = mkBridge({ walletClient: walletClient as never }, { logs: [] });
    await expect(
      bridge.redeemXRP({ amountFxrp: '1', xrplDestination: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' }),
    ).rejects.toMatchObject({ code: 'FLARE_REDEEM_NO_REQUEST_EVENT' });
  });
});

describe('FlareBridgeClient.pollRedemption', () => {
  it('throws FLARE_REDEMPTION_TIMEOUT when no terminal event in time window', async () => {
    const bridge = mkBridge({}, { logs: [] });
    await expect(
      bridge.pollRedemption(REQUEST_ID, { timeoutMs: 50, intervalMs: 10 }),
    ).rejects.toMatchObject({ code: 'FLARE_REDEMPTION_TIMEOUT' });
  });

  it('respects abort signal', async () => {
    const bridge = mkBridge({}, { logs: [] });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 5);
    await expect(
      bridge.pollRedemption(REQUEST_ID, { timeoutMs: 5_000, intervalMs: 10, signal: ac.signal }),
    ).rejects.toMatchObject({ code: 'FLARE_REDEMPTION_ABORTED' });
  });
});

describe('FlareBridgeClient.getRedemptionStatus', () => {
  it("returns 'pending' when no terminal event is found", async () => {
    const bridge = mkBridge({}, { logs: [] });
    const r = await bridge.getRedemptionStatus(REQUEST_ID);
    expect(r.kind).toBe('pending');
  });
});
