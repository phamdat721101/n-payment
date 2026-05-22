import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NPaymentError } from '../src/errors.js';
import { XrplSwapClient } from '../src/xrpl/swap.js';
import { RLUSD_ISSUERS } from '../src/xrpl/utils.js';

// ─── Test doubles ────────────────────────────────────────────────────────────

const TEST_ADDR = 'rTestAddress000000000000000000000';

function makeClient(overrides: Partial<{
  request: ReturnType<typeof vi.fn>;
  autofill: ReturnType<typeof vi.fn>;
  submitAndWait: ReturnType<typeof vi.fn>;
  isConnected: () => boolean;
}> = {}) {
  return {
    request: overrides.request ?? vi.fn(),
    autofill: overrides.autofill ?? vi.fn(async (tx) => ({ ...tx, Sequence: 1, Fee: '12' })),
    submitAndWait: overrides.submitAndWait ?? vi.fn(async () => ({
      result: { hash: '0xSWAP', meta: { TransactionResult: 'tesSUCCESS' } },
    })),
    isConnected: overrides.isConnected ?? (() => true),
  };
}

function makeConnection(client: ReturnType<typeof makeClient>) {
  return { getClient: vi.fn(async () => client) } as unknown as import('../src/xrpl/connection.js').XrplConnection;
}

function makeWallet(addr = TEST_ADDR) {
  return {
    getAddress: vi.fn(async () => addr),
    sign: vi.fn(async () => ({ tx_blob: 'BLOB', hash: '0xSWAP' })),
  } as unknown as import('../src/xrpl/wallet.js').XrplWallet;
}

// ─── quote() ─────────────────────────────────────────────────────────────────

describe('XrplSwapClient.quote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path returns sourceAmountDrops + paths + spotRate + validUntil', async () => {
    const client = makeClient({
      request: vi.fn(async () => ({
        result: {
          alternatives: [
            { source_amount: '12450000', paths_computed: [['p1']] },
            { source_amount: '12500000', paths_computed: [['p2']] },
          ],
        },
      })),
    });
    const swap = new XrplSwapClient(makeConnection(client), makeWallet(), 'testnet', RLUSD_ISSUERS.testnet);

    const before = Date.now();
    const q = await swap.quote({ from: 'XRP', to: 'RLUSD', amountOut: '5' });

    expect(q.sourceAmountDrops).toBe(12_450_000n); // picked the cheapest
    expect(q.paths).toEqual([['p1']]);
    expect(q.spotRateDropsPerUnit).toBeGreaterThan(0);
    expect(q.validUntil).toBeGreaterThanOrEqual(before + 4_900);
    expect(q.validUntil).toBeLessThanOrEqual(Date.now() + 5_500);
  });

  it('throws XRPL_NO_AMM_PATH on empty alternatives', async () => {
    const client = makeClient({
      request: vi.fn(async () => ({ result: { alternatives: [] } })),
    });
    const swap = new XrplSwapClient(makeConnection(client), makeWallet(), 'testnet', RLUSD_ISSUERS.testnet);
    await expect(swap.quote({ from: 'XRP', to: 'RLUSD', amountOut: '5' }))
      .rejects.toMatchObject({ code: 'XRPL_NO_AMM_PATH' });
  });

  it('rejects unsupported pair', async () => {
    const swap = new XrplSwapClient(makeConnection(makeClient()), makeWallet(), 'testnet', RLUSD_ISSUERS.testnet);
    await expect(swap.quote({ from: 'RLUSD' as never, to: 'XRP' as never, amountOut: '1' }))
      .rejects.toMatchObject({ code: 'XRPL_UNSUPPORTED_PAIR' });
  });
});

// ─── swap() ──────────────────────────────────────────────────────────────────

describe('XrplSwapClient.swap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds Payment with SendMax (slippage-padded) + Paths and no tfPartialPayment', async () => {
    const client = makeClient({
      request: vi.fn(async () => ({
        result: { alternatives: [{ source_amount: '10000000', paths_computed: [['p1']] }] },
      })),
    });
    const swap = new XrplSwapClient(makeConnection(client), makeWallet(), 'testnet', RLUSD_ISSUERS.testnet);

    const result = await swap.swap({ from: 'XRP', to: 'RLUSD', amountOut: '10', maxSlippageBps: 100 });

    expect(result.hash).toBe('0xSWAP');
    expect(client.autofill).toHaveBeenCalledOnce();
    const tx = (client.autofill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(tx.TransactionType).toBe('Payment');
    expect(tx.Account).toBe(TEST_ADDR);
    expect(tx.Destination).toBe(TEST_ADDR);
    expect(tx.Amount).toEqual({ currency: 'RLUSD', issuer: RLUSD_ISSUERS.testnet, value: '10' });
    expect(BigInt(tx.SendMax)).toBe(10_100_000n); // 10_000_000 * 1.01
    expect(tx.Paths).toEqual([['p1']]);
    expect(tx.Flags).toBeUndefined(); // no tfPartialPayment
  });

  it('throws XRPL_QUOTE_STALE when reusing an expired quote', async () => {
    const swap = new XrplSwapClient(makeConnection(makeClient()), makeWallet(), 'testnet', RLUSD_ISSUERS.testnet);
    await expect(swap.swap({
      from: 'XRP', to: 'RLUSD', amountOut: '1',
      quote: { sourceAmountDrops: 1n, spotRateDropsPerUnit: 1, paths: [], validUntil: Date.now() - 1 },
    })).rejects.toMatchObject({ code: 'XRPL_QUOTE_STALE' });
  });

  it('throws XRPL_SWAP_FAILED on tecPATH_PARTIAL', async () => {
    const client = makeClient({
      request: vi.fn(async () => ({
        result: { alternatives: [{ source_amount: '10000000', paths_computed: [] }] },
      })),
      submitAndWait: vi.fn(async () => ({
        result: { hash: '0xFAIL', meta: { TransactionResult: 'tecPATH_PARTIAL' } },
      })),
    });
    const swap = new XrplSwapClient(makeConnection(client), makeWallet(), 'testnet', RLUSD_ISSUERS.testnet);
    const err = await swap.swap({ from: 'XRP', to: 'RLUSD', amountOut: '10' }).catch((e) => e);
    expect(err).toBeInstanceOf(NPaymentError);
    expect((err as NPaymentError).code).toBe('XRPL_SWAP_FAILED');
  });
});
