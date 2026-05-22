import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XrplAdapter } from '../src/adapters/xrpl.js';
import { RLUSD_ISSUERS } from '../src/xrpl/utils.js';
import { clearAccountStateCache } from '../src/xrpl/payments.js';
import { NPaymentError } from '../src/errors.js';

const TEST_ADDR = 'rAdapter000000000000000000000000';
const PAY_TO = 'rMerchant00000000000000000000000';

function makeChallenge(amount: string): Response {
  const accepts = [{
    network: 'xrpl:testnet',
    payTo: PAY_TO,
    asset: 'RLUSD',
    maxAmountRequired: amount,
  }];
  const headerB64 = Buffer.from(JSON.stringify({ accepts })).toString('base64');
  return new Response(null, { status: 402, headers: { 'payment-required': headerB64 } });
}

function makeClient({ rlusdBalance = '0', xrpDrops = 1_000_000_000n }: { rlusdBalance?: string; xrpDrops?: bigint } = {}) {
  return {
    request: vi.fn(async (req: { command: string }) => {
      if (req.command === 'account_info') return { result: { account_data: { Balance: xrpDrops.toString(), Sequence: 1 } } };
      if (req.command === 'account_lines') {
        return {
          result: {
            lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: rlusdBalance, limit: '1000000000' }],
          },
        };
      }
      if (req.command === 'ripple_path_find') {
        return { result: { alternatives: [{ source_amount: '20000000', paths_computed: [['p']] }] } };
      }
      return { result: {} };
    }),
    autofill: vi.fn(async (tx) => tx),
    submitAndWait: vi.fn(async () => ({ result: { hash: '0xPAY', meta: { TransactionResult: 'tesSUCCESS' } } })),
    isConnected: () => true,
  };
}

function makeConnection(client: ReturnType<typeof makeClient>) {
  return { getClient: vi.fn(async () => client) } as unknown as import('../src/xrpl/connection.js').XrplConnection;
}

function makeWallet(addr = TEST_ADDR) {
  return {
    getAddress: vi.fn(async () => addr),
    sign: vi.fn(async () => ({ tx_blob: 'BLOB', hash: '0xPAY' })),
  } as unknown as import('../src/xrpl/wallet.js').XrplWallet;
}

function makeSwap() {
  return { swap: vi.fn(async () => ({ hash: '0xSWAP', amountInDrops: 5_050_000n, amountOut: '5', effectiveRateDropsPerUnit: 1 })) };
}

function makeTreasury({ enabled = true } = {}) {
  return {
    isEnabled: () => enabled,
    ensureLiquid: vi.fn(async () => {}),
    scheduleSweep: vi.fn(),
  };
}

beforeEach(() => {
  clearAccountStateCache();
  vi.clearAllMocks();
  // Stub global fetch (the retry HTTP call after sendRLUSD).
  vi.stubGlobal('fetch', vi.fn(async () => new Response('OK', { status: 200 })));
});

// ─── Path: pure pay (sufficient RLUSD) ───────────────────────────────────────

describe('XrplAdapter — pure pay', () => {
  it('settles directly when balance ≥ amount; never calls swap or treasury', async () => {
    const client = makeClient({ rlusdBalance: '100' });
    const swap = makeSwap();
    const treasury = makeTreasury();
    const adapter = new XrplAdapter(makeWallet(), makeConnection(client), 'testnet',
      swap as never, treasury as never, { autoSwap: true });
    const res = await adapter.pay('http://api/x', undefined, makeChallenge('5'));
    expect(res.status).toBe(200);
    expect(swap.swap).not.toHaveBeenCalled();
    expect(treasury.ensureLiquid).not.toHaveBeenCalled();
    expect(treasury.scheduleSweep).toHaveBeenCalledOnce();
  });
});

// ─── Path: treasury rescue ───────────────────────────────────────────────────

describe('XrplAdapter — treasury rescue', () => {
  it('calls treasury.ensureLiquid when balance short and treasury covers it', async () => {
    let balance = '0';
    const client = makeClient({ rlusdBalance: balance });
    // After ensureLiquid, the next account_lines should show balance topped up.
    const treasury = makeTreasury();
    treasury.ensureLiquid.mockImplementation(async () => {
      balance = '10';
      // Re-bind the lines response to reflect the topped-up balance:
      client.request.mockImplementation(async (req: { command: string }) => {
        if (req.command === 'account_info') return { result: { account_data: { Balance: '1000000000', Sequence: 1 } } };
        if (req.command === 'account_lines') return {
          result: { lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance, limit: '1' }] },
        };
        return { result: {} };
      });
    });
    const swap = makeSwap();
    const adapter = new XrplAdapter(makeWallet(), makeConnection(client), 'testnet',
      swap as never, treasury as never, { autoSwap: true });
    await adapter.pay('http://api/x', undefined, makeChallenge('5'));
    expect(treasury.ensureLiquid).toHaveBeenCalledWith('5');
    expect(swap.swap).not.toHaveBeenCalled();
  });
});

// ─── Path: swap rescue ───────────────────────────────────────────────────────

describe('XrplAdapter — swap rescue', () => {
  it('calls swap.swap when balance is short and no treasury', async () => {
    const client = makeClient({ rlusdBalance: '0' });
    const swap = makeSwap();
    const adapter = new XrplAdapter(makeWallet(), makeConnection(client), 'testnet',
      swap as never, undefined, { autoSwap: true });
    await adapter.pay('http://api/x', undefined, makeChallenge('5'));
    expect(swap.swap).toHaveBeenCalledOnce();
    const arg = swap.swap.mock.calls[0][0];
    expect(arg.from).toBe('XRP');
    expect(arg.to).toBe('RLUSD');
    expect(arg.amountOut).toBe('5');
  });

  it('throws XRPL_INSUFFICIENT_BALANCE when autoSwap disabled and balance short', async () => {
    const client = makeClient({ rlusdBalance: '0' });
    const adapter = new XrplAdapter(makeWallet(), makeConnection(client), 'testnet',
      undefined, undefined, { autoSwap: false });
    const err = await adapter.pay('http://api/x', undefined, makeChallenge('5')).catch((e) => e);
    expect(err).toBeInstanceOf(NPaymentError);
    expect((err as NPaymentError).code).toBe('XRPL_INSUFFICIENT_BALANCE');
  });
});

// ─── Path: concurrent calls serialise via mutex ──────────────────────────────

describe('XrplAdapter — concurrency', () => {
  it('serialises pays per-address (Gstack Q2): swap fires once for two parallel callers', async () => {
    const client = makeClient({ rlusdBalance: '0' });
    const swap = makeSwap();
    // After first swap, balance becomes plenty for the second pay too.
    let swapCount = 0;
    swap.swap.mockImplementation(async () => {
      swapCount++;
      // Hot-patch the connection to start returning a sufficient balance.
      client.request.mockImplementation(async (req: { command: string }) => {
        if (req.command === 'account_info') return { result: { account_data: { Balance: '1000000000', Sequence: 1 } } };
        if (req.command === 'account_lines') return {
          result: { lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '1000', limit: '1' }] },
        };
        return { result: {} };
      });
      return { hash: `0xSWAP_${swapCount}`, amountInDrops: 1n, amountOut: '5', effectiveRateDropsPerUnit: 1 };
    });
    const adapter = new XrplAdapter(makeWallet(), makeConnection(client), 'testnet',
      swap as never, undefined, { autoSwap: true });

    const [r1, r2] = await Promise.all([
      adapter.pay('http://api/a', undefined, makeChallenge('5')),
      adapter.pay('http://api/b', undefined, makeChallenge('5')),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Exactly one swap (second caller saw the topped-up balance from the first).
    expect(swap.swap).toHaveBeenCalledOnce();
  });
});
