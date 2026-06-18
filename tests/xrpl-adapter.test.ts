import { describe, it, expect, vi, beforeEach } from 'vitest';
import { XrplAdapter } from '../src/adapters/xrpl.js';
import {
  DEFAULT_SOURCE_TAG,
  RLUSD_HEX,
  RLUSD_ISSUERS,
} from '../src/xrpl/utils.js';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  type XrplPaymentRequirements,
} from '../src/xrpl/x402-scheme.js';
import { clearAccountStateCache } from '../src/xrpl/payments.js';
import { NPaymentError } from '../src/errors.js';

const BUYER = 'rBuyer000000000000000000000000000';
const MERCHANT = 'rMerchant00000000000000000000000';

// ─── Canonical T54 challenge fixture ─────────────────────────────────────────

function makeChallenge(amount: string, overrides: Partial<XrplPaymentRequirements> = {}): Response {
  const accepted: XrplPaymentRequirements = {
    scheme: 'exact',
    network: 'xrpl:1',
    asset: RLUSD_HEX,
    payTo: MERCHANT,
    amount,
    maxTimeoutSeconds: 600,
    extra: {
      sourceTag: DEFAULT_SOURCE_TAG,
      invoiceId: 'inv-test-1',
      issuer: RLUSD_ISSUERS.testnet,
    },
    ...overrides,
  };
  const headerB64 = encodePaymentRequiredHeader({ x402Version: 2, accepts: [accepted] });
  return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': headerB64 } });
}

// ─── Mocks (XRPL connection / wallet / swap / treasury) ──────────────────────

function makeClient({ rlusdBalance = '0', xrpDrops = 1_000_000_000n }: { rlusdBalance?: string; xrpDrops?: bigint } = {}) {
  return {
    request: vi.fn(async (req: { command: string }) => {
      if (req.command === 'account_info') {
        return { result: { account_data: { Balance: xrpDrops.toString(), Sequence: 1 } } };
      }
      if (req.command === 'account_lines') {
        return { result: { lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: rlusdBalance, limit: '1000000000' }] } };
      }
      return { result: {} };
    }),
    autofill: vi.fn(async (tx: Record<string, unknown>) => ({
      ...tx,
      Sequence: 42,
      Fee: '12',
      LastLedgerSequence: 5_000,
    })),
    submitAndWait: vi.fn(async () => ({ result: { hash: 'TXTRUST', meta: { TransactionResult: 'tesSUCCESS' } } })),
    isConnected: () => true,
  };
}

function makeConnection(client: ReturnType<typeof makeClient>) {
  return { getClient: vi.fn(async () => client) } as unknown as import('../src/xrpl/connection.js').XrplConnection;
}

function makeWallet(addr = BUYER) {
  return {
    getAddress: vi.fn(async () => addr),
    sign: vi.fn(async () => ({ tx_blob: 'SIGNEDBLOB1234', hash: '0xPAY' })),
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
  vi.stubGlobal('fetch', vi.fn(async () => new Response('OK', { status: 200 })));
});

// ─── detect() ────────────────────────────────────────────────────────────────

describe('XrplAdapter — detect', () => {
  it('matches canonical PAYMENT-REQUIRED with RLUSD_HEX asset on xrpl:1', () => {
    const adapter = new XrplAdapter(makeWallet(), makeConnection(makeClient()), 'testnet');
    expect(adapter.detect(makeChallenge('1'))).toBe(true);
  });

  it('rejects non-XRPL networks (different protocol family)', () => {
    const adapter = new XrplAdapter(makeWallet(), makeConnection(makeClient()), 'testnet');
    const bad = new Response(null, {
      status: 402,
      headers: {
        'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({
          x402Version: 2,
          accepts: [{
            scheme: 'exact',
            network: 'eip155:8453',
            asset: 'USDC',
            payTo: '0xabc',
            amount: '1',
            maxTimeoutSeconds: 600,
            extra: { sourceTag: 1, invoiceId: 'i' },
          }],
        })).toString('base64'),
      },
    });
    expect(adapter.detect(bad)).toBe(false);
  });

  it('returns false on missing or malformed PAYMENT-REQUIRED', () => {
    const adapter = new XrplAdapter(makeWallet(), makeConnection(makeClient()), 'testnet');
    expect(adapter.detect(new Response(null, { status: 402 }))).toBe(false);
    expect(adapter.detect(new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': '!!!' } }))).toBe(false);
  });
});

// ─── pay() — pure path ───────────────────────────────────────────────────────

describe('XrplAdapter — pure pay (sufficient RLUSD)', () => {
  it('signs a Payment, retries with PAYMENT-SIGNATURE, never calls swap or treasury', async () => {
    const client = makeClient({ rlusdBalance: '100' });
    const swap = makeSwap();
    const treasury = makeTreasury();
    const wallet = makeWallet();
    const adapter = new XrplAdapter(wallet, makeConnection(client), 'testnet',
      swap as never, treasury as never, { autoSwap: true });

    const fetchMock = vi.fn(async () => new Response('OK', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await adapter.pay('http://api/x', undefined, makeChallenge('5'));
    expect(res.status).toBe(200);
    expect(swap.swap).not.toHaveBeenCalled();
    expect(treasury.ensureLiquid).not.toHaveBeenCalled();
    expect(treasury.scheduleSweep).toHaveBeenCalledOnce();
    expect(wallet.sign).toHaveBeenCalledOnce();

    // Inspect the retry: PAYMENT-SIGNATURE present, decodes back to the challenge accepted body.
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    const sigHeader = headers.get('PAYMENT-SIGNATURE');
    expect(sigHeader).toBeTruthy();
    const env = decodePaymentSignatureHeader(sigHeader!);
    expect(env.accepted.asset).toBe(RLUSD_HEX);
    expect(env.accepted.payTo).toBe(MERCHANT);
    expect(env.accepted.amount).toBe('5');
    expect(env.accepted.extra.invoiceId).toBe('inv-test-1');
    expect(env.payload.signedTxBlob).toBe('SIGNEDBLOB1234');
  });
});

// ─── pay() — treasury rescue ─────────────────────────────────────────────────

describe('XrplAdapter — treasury rescue', () => {
  it('calls treasury.ensureLiquid when balance short and treasury covers it', async () => {
    let balance = '0';
    const client = makeClient({ rlusdBalance: balance });
    const treasury = makeTreasury();
    treasury.ensureLiquid.mockImplementation(async () => {
      balance = '10';
      client.request.mockImplementation(async (req: { command: string }) => {
        if (req.command === 'account_info') return { result: { account_data: { Balance: '1000000000', Sequence: 1 } } };
        if (req.command === 'account_lines') return { result: { lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance, limit: '1' }] } };
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

// ─── pay() — swap rescue ─────────────────────────────────────────────────────

describe('XrplAdapter — swap rescue', () => {
  it('calls swap.swap when balance is short and no treasury', async () => {
    const client = makeClient({ rlusdBalance: '0' });
    // After swap, raise the balance so the build path proceeds.
    const swap = makeSwap();
    swap.swap.mockImplementation(async () => {
      client.request.mockImplementation(async (req: { command: string }) => {
        if (req.command === 'account_info') return { result: { account_data: { Balance: '1000000000', Sequence: 1 } } };
        if (req.command === 'account_lines') return { result: { lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '1000', limit: '1' }] } };
        return { result: {} };
      });
      return { hash: '0xSWAP', amountInDrops: 1n, amountOut: '5', effectiveRateDropsPerUnit: 1 };
    });
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

// ─── pay() — XRP-asset stub ──────────────────────────────────────────────────

describe('XrplAdapter — XRP asset (RLUSD-first)', () => {
  it('throws XRPL_X402_XRP_PENDING for XRP-asset challenges', async () => {
    const client = makeClient({ rlusdBalance: '100' });
    const adapter = new XrplAdapter(makeWallet(), makeConnection(client), 'testnet');
    const ch = makeChallenge('1000', { asset: 'XRP', extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId: 'i' } });
    const err = await adapter.pay('http://api/x', undefined, ch).catch((e) => e);
    expect(err).toBeInstanceOf(NPaymentError);
    expect((err as NPaymentError).code).toBe('XRPL_X402_XRP_PENDING');
  });
});

// ─── pay() — concurrency mutex ───────────────────────────────────────────────

describe('XrplAdapter — concurrency', () => {
  it('serialises pays per-address: swap fires once for two parallel callers', async () => {
    const client = makeClient({ rlusdBalance: '0' });
    const swap = makeSwap();
    let swapCount = 0;
    swap.swap.mockImplementation(async () => {
      swapCount++;
      client.request.mockImplementation(async (req: { command: string }) => {
        if (req.command === 'account_info') return { result: { account_data: { Balance: '1000000000', Sequence: 1 } } };
        if (req.command === 'account_lines') return { result: { lines: [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '1000', limit: '1' }] } };
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
    expect(swap.swap).toHaveBeenCalledOnce();
  });
});
