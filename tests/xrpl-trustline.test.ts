import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ensureTrustline,
  clearTrustlineCache,
  ensureTrustLine,
} from '../src/xrpl/payments.js';
import { RLUSD_CURRENCY, RLUSD_ISSUERS } from '../src/xrpl/utils.js';
import { NPaymentError } from '../src/errors.js';

// ─── Mocks (rippled client + wallet) ────────────────────────────────────────

const PAYTO = 'rMerchant00000000000000000000000';
const ALT   = 'rOther00000000000000000000000000';

interface FakeClientOpts {
  hasLine?: boolean;
  /** Optional override of the line's issuer / currency for negative tests. */
  lineCurrency?: string;
  lineIssuer?: string;
  /** Track submitAndWait calls. */
  submitHash?: string;
}

function makeClient(opts: FakeClientOpts = {}) {
  const { hasLine = false, lineCurrency = RLUSD_CURRENCY, submitHash = 'TXTRUSTSET' } = opts;
  const lineIssuer = opts.lineIssuer ?? RLUSD_ISSUERS.testnet;
  return {
    request: vi.fn(async (req: { command: string }) => {
      if (req.command === 'account_lines') {
        return {
          result: {
            lines: hasLine
              ? [{ currency: lineCurrency, account: lineIssuer, balance: '0', limit: '1000000000' }]
              : [],
          },
        };
      }
      return { result: {} };
    }),
    autofill: vi.fn(async (tx: Record<string, unknown>) => ({ ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 5_000 })),
    submitAndWait: vi.fn(async () => ({ result: { hash: submitHash, validated: true } })),
    isConnected: () => true,
  };
}

function makeConn(client: ReturnType<typeof makeClient>) {
  return { getClient: vi.fn(async () => client) } as never;
}

function makeSigner(addr: string) {
  return {
    getAddress: vi.fn(async () => addr),
    sign: vi.fn(async () => ({ tx_blob: 'SIGNEDTRUSTSET', hash: '0xTRUST' })),
  } as never;
}

beforeEach(() => {
  clearTrustlineCache();
  vi.clearAllMocks();
});

// =================================================================
// Section A — ensureTrustline (helper unit)
// =================================================================

describe('ensureTrustline — Section A', () => {
  it('A1: trustline exists → { ok: true, alreadyExisted: true }, no submitAndWait', async () => {
    const client = makeClient({ hasLine: true });
    const state = await ensureTrustline(makeConn(client), { address: PAYTO, issuer: RLUSD_ISSUERS.testnet });
    expect(state.ok).toBe(true);
    expect(state.alreadyExisted).toBe(true);
    expect(client.submitAndWait).not.toHaveBeenCalled();
  });

  it('A2: missing + signer (matching addr) → submits TrustSet, returns ok with txHash', async () => {
    const client = makeClient({ hasLine: false, submitHash: 'TXOK' });
    const signer = makeSigner(PAYTO);
    const state = await ensureTrustline(makeConn(client), { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, signer });
    expect(state.ok).toBe(true);
    expect(state.txHash).toBe('TXOK');
    expect(state.alreadyExisted).toBeUndefined();
    expect(client.submitAndWait).toHaveBeenCalledOnce();
    // signer must have been called once (sign one tx)
    expect((signer as unknown as { sign: ReturnType<typeof vi.fn> }).sign).toHaveBeenCalledOnce();
  });

  it('A3: missing + no signer → { ok: false, reason: "missing", hint }', async () => {
    const client = makeClient({ hasLine: false });
    const state = await ensureTrustline(makeConn(client), { address: PAYTO, issuer: RLUSD_ISSUERS.testnet });
    expect(state.ok).toBe(false);
    expect(state.reason).toBe('missing');
    expect(state.hint).toMatch(/trustline/i);
    expect(client.submitAndWait).not.toHaveBeenCalled();
  });

  it('A4: signer address mismatch → throws XRPL_TRUSTLINE_SIGNER_MISMATCH', async () => {
    const client = makeClient({ hasLine: false });
    const signer = makeSigner(ALT); // signer derives a DIFFERENT address than `address`
    await expect(
      ensureTrustline(makeConn(client), { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, signer }),
    ).rejects.toMatchObject({ code: 'XRPL_TRUSTLINE_SIGNER_MISMATCH' });
    expect(client.submitAndWait).not.toHaveBeenCalled();
  });

  it('A5: cache hit within TTL → no second account_lines call', async () => {
    const client = makeClient({ hasLine: true });
    const conn = makeConn(client);
    const s1 = await ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet });
    const s2 = await ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet });
    expect(s1.ok && s2.ok).toBe(true);
    // Only one account_lines round-trip.
    const lineCalls = client.request.mock.calls.filter(c => c[0].command === 'account_lines').length;
    expect(lineCalls).toBe(1);
  });

  it('A6: cache TTL elapsed → re-checks ledger', async () => {
    const client = makeClient({ hasLine: true });
    const conn = makeConn(client);
    await ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, cacheTtlMs: 0 });
    await ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, cacheTtlMs: 0 });
    const lineCalls = client.request.mock.calls.filter(c => c[0].command === 'account_lines').length;
    expect(lineCalls).toBeGreaterThanOrEqual(2);
  });

  it('A7: parallel callers (no signer) coalesced — single account_lines call', async () => {
    const client = makeClient({ hasLine: true });
    const conn = makeConn(client);
    const [a, b, c] = await Promise.all([
      ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet }),
      ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet }),
      ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet }),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    const lineCalls = client.request.mock.calls.filter(c => c[0].command === 'account_lines').length;
    expect(lineCalls).toBe(1); // mutex coalesces
  });

  it('A8: parallel callers (with signer) coalesced — single TrustSet submitted', async () => {
    const client = makeClient({ hasLine: false });
    const signer = makeSigner(PAYTO);
    const conn = makeConn(client);
    const results = await Promise.all([
      ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, signer }),
      ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, signer }),
      ensureTrustline(conn, { address: PAYTO, issuer: RLUSD_ISSUERS.testnet, signer }),
    ]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(client.submitAndWait).toHaveBeenCalledOnce(); // mutex coalesces, single submit
  });
});

describe('ensureTrustLine — Section A (back-compat wrapper)', () => {
  it('A9: legacy wrapper still returns null when line exists, hash when created', async () => {
    // Line exists path
    const c1 = makeClient({ hasLine: true });
    const r1 = await ensureTrustLine(makeConn(c1), makeSigner(PAYTO), { issuer: RLUSD_ISSUERS.testnet });
    expect(r1).toBeNull();

    // Line missing path — wrapper signs via wallet (matches legacy semantics)
    clearTrustlineCache();
    const c2 = makeClient({ hasLine: false, submitHash: 'TXLEGACY' });
    const r2 = await ensureTrustLine(makeConn(c2), makeSigner(PAYTO), { issuer: RLUSD_ISSUERS.testnet });
    expect(r2).toBe('TXLEGACY');
  });
});

// =================================================================
// Section B — middleware wiring (handleXrplRoute preflight)
// =================================================================

// Mock xrpl Wallet.fromSeed so XrplWallet's lazy import does not need
// a real `xrpl` testnet connection. We replace the entire module surface
// the production code touches: { Wallet }.
vi.mock('xrpl', () => ({
  Wallet: { fromSeed: vi.fn((_seed: string) => ({
    classicAddress: PAYTO,
    address: PAYTO,
    sign: vi.fn(() => ({ tx_blob: 'SIGNEDTRUSTSET', hash: '0xTRUST' })),
  })) },
  Client: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), isConnected: () => false })),
}));

// Mock the connection module so the middleware's getXrplConnection() returns
// a controllable client without hitting a real WebSocket.
let middlewareClient: ReturnType<typeof makeClient> | null = null;
vi.mock('../src/xrpl/connection.js', () => ({
  XrplConnection: vi.fn(function (this: { getClient: () => unknown; disconnect: () => Promise<void> }) {
    this.getClient = async () => middlewareClient ?? makeClient({ hasLine: true });
    this.disconnect = async () => {};
  }),
}));

function makeReq(method = 'GET', path = '/paid', headers: Record<string, unknown> = {}) {
  return { method, path, headers, hostname: 'localhost' } as never;
}
function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  let bodyJson: unknown = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { bodyJson = body; },
    setHeader(name: string, value: string) { headers[name] = value; },
    _headers: headers,
    get _status() { return statusCode; },
    get _body() { return bodyJson as Record<string, unknown>; },
  };
}

describe('createPaywall — Section B (XRPL merchant trustline preflight)', () => {
  beforeEach(() => {
    clearTrustlineCache();
    middlewareClient = null;
  });

  it('B1: missing trustline + no merchant signer → 503 XRPL_MERCHANT_NO_TRUSTLINE', async () => {
    const { createPaywall } = await import('../src/middleware.js');
    middlewareClient = makeClient({ hasLine: false });

    const mw = createPaywall({
      routes: { 'GET /paid': { price: '0.01', xrpl: { payTo: PAYTO, network: 'xrpl:1', asset: 'RLUSD' } } },
    });
    const r = makeRes();
    let nextCalled = false;
    mw(makeReq(), r as never, () => { nextCalled = true; });

    // Allow the spawned async helper to run.
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(nextCalled).toBe(false);
    expect(r._status).toBe(503);
    expect(r._body.error).toBe('XRPL_MERCHANT_NO_TRUSTLINE');
    expect(r._body.hint).toMatch(/Set xrpl\.seed/);
  });

  it('B2: missing trustline + seed configured → auto-create, then PAYMENT-REQUIRED on 402', async () => {
    const { createPaywall } = await import('../src/middleware.js');
    middlewareClient = makeClient({ hasLine: false, submitHash: 'TXAUTOCREATE' });

    const mw = createPaywall({
      routes: { 'GET /paid': { price: '0.01', xrpl: { payTo: PAYTO, network: 'xrpl:1', asset: 'RLUSD' } } },
      xrpl: { seed: 'sEd_DUMMY_TESTNET_SEED_VALUE' },
    });
    const r = makeRes();
    mw(makeReq(), r as never, () => {});
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(r._status).toBe(402);
    expect(r._headers['PAYMENT-REQUIRED']).toBeTruthy();
    expect(r._body.error).toBe('Payment required');
    // submitAndWait was invoked exactly once (auto-create).
    expect(middlewareClient!.submitAndWait).toHaveBeenCalledOnce();
  });

  it('B3: trustline exists → cached preflight, normal challenge issued without submit', async () => {
    const { createPaywall } = await import('../src/middleware.js');
    middlewareClient = makeClient({ hasLine: true });

    const mw = createPaywall({
      routes: { 'GET /paid': { price: '0.01', xrpl: { payTo: PAYTO, network: 'xrpl:1', asset: 'RLUSD' } } },
    });
    const r = makeRes();
    mw(makeReq(), r as never, () => {});
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(r._status).toBe(402);
    expect(r._headers['PAYMENT-REQUIRED']).toBeTruthy();
    expect(middlewareClient!.submitAndWait).not.toHaveBeenCalled();
  });

  it('B4: XRP-asset route is not preflighted (no trustline needed for native XRP)', async () => {
    const { createPaywall } = await import('../src/middleware.js');
    // Even with hasLine=false, an XRP route must not 503 — preflight must be skipped.
    middlewareClient = makeClient({ hasLine: false });

    const mw = createPaywall({
      routes: { 'GET /paid': { price: '1000', xrpl: { payTo: PAYTO, network: 'xrpl:1', asset: 'XRP' } } },
    });
    const r = makeRes();
    mw(makeReq(), r as never, () => {});
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));

    expect(r._status).toBe(402);
    expect(r._headers['PAYMENT-REQUIRED']).toBeTruthy();
    // No account_lines lookup, no submit.
    const lineCalls = middlewareClient!.request.mock.calls.filter(c => (c[0] as { command: string }).command === 'account_lines').length;
    expect(lineCalls).toBe(0);
    expect(middlewareClient!.submitAndWait).not.toHaveBeenCalled();
  });
});
