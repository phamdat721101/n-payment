import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  defaultFacilitatorUrl,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  hexInvoiceMemo,
  XrplFacilitatorClient,
  type PaymentRequiredEnvelope,
  type PaymentSignatureEnvelope,
  type XrplPaymentRequirements,
} from '../src/xrpl/x402-scheme.js';
import { DEFAULT_SOURCE_TAG, RLUSD_HEX, RLUSD_ISSUERS } from '../src/xrpl/utils.js';
import { _seedTrustlineCacheOk, clearTrustlineCache } from '../src/xrpl/payments.js';
import { NPaymentError } from '../src/errors.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const RLUSD_REQ: XrplPaymentRequirements = {
  scheme: 'exact',
  network: 'xrpl:1',
  asset: RLUSD_HEX,
  payTo: 'rMerchant00000000000000000000000',
  amount: '0.01',
  maxTimeoutSeconds: 600,
  extra: {
    sourceTag: DEFAULT_SOURCE_TAG,
    invoiceId: 'inv-abc-123',
    issuer: RLUSD_ISSUERS.testnet,
  },
};

const SIG_ENV: PaymentSignatureEnvelope = {
  x402Version: 2,
  accepted: RLUSD_REQ,
  payload: { signedTxBlob: '1200002280000000DEADBEEF' },
};

// =================================================================
// Section A — pure scheme round-trips (Task 1)
// =================================================================

describe('xrpl x402 scheme — encode/decode round-trips', () => {
  it('PAYMENT-REQUIRED: encodes RLUSD challenge with issuer + decodes back equal', () => {
    const env: PaymentRequiredEnvelope = { x402Version: 2, accepts: [RLUSD_REQ] };
    const header = encodePaymentRequiredHeader(env);
    expect(typeof header).toBe('string');
    expect(header.length).toBeGreaterThan(0);
    const back = decodePaymentRequiredHeader(header);
    expect(back).toEqual(env);
    expect(back.accepts[0].extra.issuer).toBe(RLUSD_ISSUERS.testnet);
  });

  it('PAYMENT-REQUIRED: encodes XRP challenge (no issuer) and round-trips', () => {
    const xrpReq: XrplPaymentRequirements = {
      scheme: 'exact',
      network: 'xrpl:1',
      asset: 'XRP',
      payTo: 'rMerchant00000000000000000000000',
      amount: '1000',
      maxTimeoutSeconds: 600,
      extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId: 'inv-xrp-1' },
    };
    const env: PaymentRequiredEnvelope = { x402Version: 2, accepts: [xrpReq] };
    const back = decodePaymentRequiredHeader(encodePaymentRequiredHeader(env));
    expect(back.accepts[0].asset).toBe('XRP');
    expect(back.accepts[0].extra.issuer).toBeUndefined();
  });

  it('PAYMENT-REQUIRED: rejects IOU asset without issuer', () => {
    const bad: XrplPaymentRequirements = { ...RLUSD_REQ, extra: { ...RLUSD_REQ.extra, issuer: undefined } };
    expect(() => encodePaymentRequiredHeader({ x402Version: 2, accepts: [bad] })).toThrow(/issuer required/i);
  });

  it('PAYMENT-REQUIRED: rejects unknown CAIP-2 network', () => {
    const bad = { ...RLUSD_REQ, network: 'xrpl:9' as never };
    expect(() => encodePaymentRequiredHeader({ x402Version: 2, accepts: [bad] })).toThrow(NPaymentError);
  });

  it('PAYMENT-SIGNATURE: round-trips with signedTxBlob', () => {
    const back = decodePaymentSignatureHeader(encodePaymentSignatureHeader(SIG_ENV));
    expect(back).toEqual(SIG_ENV);
  });

  it('PAYMENT-SIGNATURE: rejects empty signedTxBlob', () => {
    const bad: PaymentSignatureEnvelope = { ...SIG_ENV, payload: { signedTxBlob: '' } };
    expect(() => encodePaymentSignatureHeader(bad)).toThrow(/signedTxBlob required/i);
  });

  it('PAYMENT-RESPONSE: round-trips and returns null on garbage', () => {
    const env = { success: true, transaction: 'ABC123', network: 'xrpl:1' as const, payer: 'rPay' };
    expect(decodePaymentResponseHeader(encodePaymentResponseHeader(env))).toEqual(env);
    expect(decodePaymentResponseHeader('!!!not-base64!!!')).toBeNull();
  });

  it('decoder: rejects malformed base64 / JSON with NPaymentError', () => {
    expect(() => decodePaymentRequiredHeader('')).toThrow(/missing.*PAYMENT-REQUIRED/i);
    expect(() => decodePaymentRequiredHeader('not-base64-***')).toThrow(NPaymentError);
    // Valid base64 but not JSON.
    const garbage = Buffer.from('hello world', 'utf8').toString('base64');
    expect(() => decodePaymentRequiredHeader(garbage)).toThrow(/JSON parse failed/i);
  });
});

describe('xrpl x402 scheme — Memo invoice binding', () => {
  it('hexInvoiceMemo: encodes UTF-8 invoice id to uppercase hex', () => {
    const memo = hexInvoiceMemo('inv-abc');
    // 'inv-abc' = 696e762d616263 -> uppercase
    expect(memo.Memo.MemoData).toBe('696E762D616263');
  });

  it('hexInvoiceMemo: rejects empty', () => {
    expect(() => hexInvoiceMemo('')).toThrow(NPaymentError);
  });

  it('hexInvoiceMemo: rejects oversize (> 1024 bytes)', () => {
    const big = 'x'.repeat(1025);
    expect(() => hexInvoiceMemo(big)).toThrow(/too large/i);
  });
});

describe('xrpl x402 scheme — defaultFacilitatorUrl', () => {
  it('returns T54 testnet URL for testnet', () => {
    expect(defaultFacilitatorUrl('testnet')).toBe('https://xrpl-facilitator-testnet.t54.ai');
  });

  it('returns T54 mainnet URL for mainnet', () => {
    expect(defaultFacilitatorUrl('mainnet')).toBe('https://xrpl-facilitator-mainnet.t54.ai');
  });
});

// =================================================================
// Section C — XrplFacilitatorClient (Task 4)
// =================================================================

describe('XrplFacilitatorClient — POST /verify and /settle', () => {
  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    return vi.fn(async (url: string, init: RequestInit) => handler(url, init)) as unknown as typeof fetch;
  }

  it('verify: posts the canonical body and returns isValid=true', async () => {
    let captured: { url: string; body: any } | null = null;
    const f = mockFetch((url, init) => {
      captured = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ isValid: true, payer: 'rPayer' }), { status: 200 });
    });
    const c = new XrplFacilitatorClient('https://fac.example.com/', f);
    const r = await c.verify({ paymentPayload: SIG_ENV, paymentRequirements: RLUSD_REQ });
    expect(r.isValid).toBe(true);
    expect(r.payer).toBe('rPayer');
    expect(captured!.url).toBe('https://fac.example.com/verify');
    expect(captured!.body.paymentPayload).toEqual(SIG_ENV);
    expect(captured!.body.paymentRequirements).toEqual(RLUSD_REQ);
  });

  it('verify: surfaces invalidReason cleanly', async () => {
    const f = mockFetch(() =>
      new Response(JSON.stringify({ isValid: false, invalidReason: 'amount_mismatch' }), { status: 200 }),
    );
    const c = new XrplFacilitatorClient('https://fac', f);
    const r = await c.verify({ paymentPayload: SIG_ENV, paymentRequirements: RLUSD_REQ });
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('amount_mismatch');
  });

  it('settle: returns success + transaction hash', async () => {
    const f = mockFetch(() =>
      new Response(
        JSON.stringify({ success: true, transaction: 'ABCDEF', network: 'xrpl:1', payer: 'rPay' }),
        { status: 200 },
      ),
    );
    const c = new XrplFacilitatorClient('https://fac', f);
    const r = await c.settle({ paymentPayload: SIG_ENV, paymentRequirements: RLUSD_REQ });
    expect(r.success).toBe(true);
    expect(r.transaction).toBe('ABCDEF');
  });

  it('non-2xx response throws XRPL_FACILITATOR_FAILED', async () => {
    const f = mockFetch(() => new Response('upstream down', { status: 502 }));
    const c = new XrplFacilitatorClient('https://fac', f);
    const err = await c.settle({ paymentPayload: SIG_ENV, paymentRequirements: RLUSD_REQ }).catch((e) => e);
    expect(err).toBeInstanceOf(NPaymentError);
    expect((err as NPaymentError).code).toBe('XRPL_FACILITATOR_FAILED');
  });
});

// =================================================================
// Section B — buildXrplRlusdPaymentTx (Task 2)
// =================================================================

describe('buildXrplRlusdPaymentTx — RLUSD presigned tx with invoice binding', () => {
  function mockConnection(currentLls = 1000) {
    const client = {
      autofill: vi.fn(async (tx: Record<string, unknown>) => ({
        ...tx,
        Sequence: 42,
        Fee: '12',
        LastLedgerSequence: currentLls,
      })),
    };
    const conn = { getClient: vi.fn(async () => client) };
    return { conn: conn as never, client };
  }

  it('builds a Payment with Memo binding, SourceTag, and extended LastLedgerSequence', async () => {
    const { buildXrplRlusdPaymentTx } = await import('../src/xrpl/payments.js');
    const { conn } = mockConnection(1000);
    const tx = await buildXrplRlusdPaymentTx(conn, {
      fromAddress: 'rBuyer000000000000000000000000000',
      payTo: 'rMerchant00000000000000000000000',
      amount: '0.01',
      issuer: RLUSD_ISSUERS.testnet,
      invoiceId: 'inv-abc',
    });
    expect(tx.TransactionType).toBe('Payment');
    expect(tx.Account).toMatch(/^r/);
    expect(tx.Destination).toBe('rMerchant00000000000000000000000');
    expect(tx.Amount).toEqual({ currency: RLUSD_HEX, issuer: RLUSD_ISSUERS.testnet, value: '0.01' });
    expect(tx.SourceTag).toBe(DEFAULT_SOURCE_TAG);
    expect((tx.Memos as Array<{ Memo: { MemoData: string } }>)[0].Memo.MemoData).toBe('696E762D616263');
    expect(tx.LastLedgerSequence).toBe(1020); // 1000 + default offset 20
  });

  it('honors custom sourceTag, destinationTag, and lastLedgerOffset', async () => {
    const { buildXrplRlusdPaymentTx } = await import('../src/xrpl/payments.js');
    const { conn } = mockConnection(2000);
    const tx = await buildXrplRlusdPaymentTx(conn, {
      fromAddress: 'rBuyer000000000000000000000000000',
      payTo: 'rMerchant00000000000000000000000',
      amount: '5',
      issuer: RLUSD_ISSUERS.mainnet,
      invoiceId: 'inv-xyz',
      sourceTag: 12345,
      destinationTag: 7,
      lastLedgerOffset: 50,
    });
    expect(tx.SourceTag).toBe(12345);
    expect(tx.DestinationTag).toBe(7);
    expect(tx.LastLedgerSequence).toBe(2050);
  });

  it('rejects invalid addresses and missing invoice', async () => {
    const { buildXrplRlusdPaymentTx } = await import('../src/xrpl/payments.js');
    const { conn } = mockConnection();
    await expect(
      buildXrplRlusdPaymentTx(conn, {
        fromAddress: 'NOTANADDRESS',
        payTo: 'rMerchant00000000000000000000000',
        amount: '1',
        issuer: RLUSD_ISSUERS.testnet,
        invoiceId: 'inv-1',
      }),
    ).rejects.toThrow(NPaymentError);
    await expect(
      buildXrplRlusdPaymentTx(conn, {
        fromAddress: 'rBuyer000000000000000000000000000',
        payTo: 'rMerchant00000000000000000000000',
        amount: '1',
        issuer: RLUSD_ISSUERS.testnet,
        invoiceId: '',
      }),
    ).rejects.toThrow(NPaymentError);
  });

  it('Amount + SendMax carry the canonical 40-hex RLUSD currency code + issuer', async () => {
    const { buildXrplRlusdPaymentTx } = await import('../src/xrpl/payments.js');
    const { conn } = mockConnection();
    const tx = await buildXrplRlusdPaymentTx(conn, {
      fromAddress: 'rBuyer000000000000000000000000000',
      payTo: 'rMerchant00000000000000000000000',
      amount: '0.01',
      issuer: RLUSD_ISSUERS.testnet,
      invoiceId: 'inv-abc',
    });
    const amt = tx.Amount as { currency: string; issuer: string };
    expect(amt.currency).toBe(RLUSD_HEX);
    expect(amt.issuer).toBe(RLUSD_ISSUERS.testnet);
    // T54 IOU policy: SendMax must equal Amount (same currency+issuer+value).
    const sendMax = tx.SendMax as { currency: string; issuer: string; value: string };
    expect(sendMax.currency).toBe(RLUSD_HEX);
    expect(sendMax.issuer).toBe(RLUSD_ISSUERS.testnet);
    expect(sendMax.value).toBe('0.01');
  });
});

// =================================================================
// Section D — merchant middleware (Task 5)
// =================================================================

describe('createPaywall — XRPL x402 (T54 canonical) merchant flow', () => {
  // We import lazily so we can stub fetch BEFORE the facilitator client cache
  // is populated for any URL. clearXrplInvoiceCache() also keeps tests deterministic.

  // v0.29: trustline preflight runs before challenge issuance + settle. These
  // legacy tests don't mock the XrplConnection, so we pre-seed the cache for
  // every payTo + RLUSD-testnet-issuer pair the tests use. This makes preflight
  // a cache hit (zero network calls) and preserves the existing assertions.
  beforeEach(() => {
    clearTrustlineCache();
    _seedTrustlineCacheOk('rMerchant00000000000000000000000', RLUSD_ISSUERS.testnet);
    _seedTrustlineCacheOk('rM', RLUSD_ISSUERS.testnet);
  });

  function makeReq(method = 'GET', path = '/paid', headers: Record<string, any> = {}) {
    return { method, path, headers, hostname: 'localhost' };
  }

  function makeRes() {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let bodyJson: any = null;
    return {
      status(code: number) { statusCode = code; return this; },
      json(body: any) { bodyJson = body; },
      setHeader(name: string, value: string) { headers[name] = value; },
      _headers: headers,
      get _status() { return statusCode; },
      get _body() { return bodyJson; },
    };
  }

  function buildSigEnvelope(
    accepted: XrplPaymentRequirements,
    blob = 'SIGNEDBLOBOK',
  ): string {
    return encodePaymentSignatureHeader({ x402Version: 2, accepted, payload: { signedTxBlob: blob } });
  }

  it('issues canonical PAYMENT-REQUIRED with invoiceId, sourceTag, RLUSD_HEX + issuer', async () => {
    const { createPaywall, clearXrplInvoiceCache } = await import('../src/middleware.js');
    clearXrplInvoiceCache();
    const mw = createPaywall({
      routes: {
        'GET /paid': {
          price: '0.01',
          xrpl: { payTo: 'rMerchant00000000000000000000000', network: 'xrpl:1', asset: 'RLUSD' },
        },
      },
    });
    const req = makeReq('GET', '/paid');
    const res = makeRes();
    let nextCalled = false;
    mw(req as any, res as any, () => { nextCalled = true; });

    // v0.29: trustline preflight is async (cache hit, but still microtask).
    await new Promise((r) => setTimeout(r, 0));

    expect(res._status).toBe(402);
    expect(nextCalled).toBe(false);
    expect(res._body.invoiceId).toMatch(/[0-9a-f-]{36}/);
    const challenge = res._headers['PAYMENT-REQUIRED'];
    expect(challenge).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(challenge, 'base64').toString());
    expect(decoded.x402Version).toBe(2);
    const a = decoded.accepts[0];
    expect(a.scheme).toBe('exact');
    expect(a.network).toBe('xrpl:1');
    expect(a.asset).toBe(RLUSD_HEX);
    expect(a.payTo).toBe('rMerchant00000000000000000000000');
    expect(a.amount).toBe('0.01');
    expect(a.extra.sourceTag).toBe(DEFAULT_SOURCE_TAG);
    expect(a.extra.invoiceId).toBe(res._body.invoiceId);
    expect(a.extra.issuer).toBe(RLUSD_ISSUERS.testnet);
  });

  it('valid PAYMENT-SIGNATURE: verifies then settles via facilitator and calls next() with PAYMENT-RESPONSE', async () => {
    const { createPaywall, clearXrplInvoiceCache } = await import('../src/middleware.js');
    clearXrplInvoiceCache();

    const facilitatorCalls: { path: string; body: any }[] = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      facilitatorCalls.push({ path, body: JSON.parse(init.body as string) });
      if (path === '/verify') return new Response(JSON.stringify({ isValid: true, payer: 'rPayer' }), { status: 200 });
      if (path === '/settle') return new Response(JSON.stringify({ success: true, transaction: 'TXHASHABC', network: 'xrpl:1', payer: 'rPayer' }), { status: 200 });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fakeFetch);

    const mw = createPaywall({
      routes: {
        'GET /paid': {
          price: '0.01',
          xrpl: { payTo: 'rMerchant00000000000000000000000', network: 'xrpl:1', asset: 'RLUSD' },
        },
      },
    });

    // 1. Mint invoice via challenge call.
    const challengeRes = makeRes();
    mw(makeReq('GET', '/paid') as any, challengeRes as any, () => {});
    await new Promise((r) => setTimeout(r, 0));
    const invoiceId = challengeRes._body.invoiceId as string;

    // 2. Buyer crafts a matching PAYMENT-SIGNATURE.
    const accepted: XrplPaymentRequirements = {
      scheme: 'exact',
      network: 'xrpl:1',
      asset: RLUSD_HEX,
      payTo: 'rMerchant00000000000000000000000',
      amount: '0.01',
      maxTimeoutSeconds: 600,
      extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId, issuer: RLUSD_ISSUERS.testnet },
    };
    const sig = buildSigEnvelope(accepted);

    // 3. Retry hits the merchant; settlement must succeed and pass-through to handler.
    const retryRes = makeRes();
    let nextCalled = false;
    mw(makeReq('GET', '/paid', { 'payment-signature': sig }) as any, retryRes as any, () => { nextCalled = true; });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(nextCalled).toBe(true);
    const respHeader = retryRes._headers['PAYMENT-RESPONSE'];
    expect(respHeader).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(respHeader, 'base64').toString());
    expect(decoded).toMatchObject({ success: true, transaction: 'TXHASHABC', network: 'xrpl:1', payer: 'rPayer' });

    // Facilitator was called twice in order: verify then settle.
    expect(facilitatorCalls.map((c) => c.path)).toEqual(['/verify', '/settle']);
  });

  it('replay: re-using a consumed invoiceId returns invoice_already_consumed', async () => {
    const { createPaywall, clearXrplInvoiceCache } = await import('../src/middleware.js');
    clearXrplInvoiceCache();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/verify') return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      return new Response(JSON.stringify({ success: true, transaction: 'TXOK', network: 'xrpl:1' }), { status: 200 });
    }));

    const mw = createPaywall({
      routes: {
        'GET /paid': { price: '0.01', xrpl: { payTo: 'rM', network: 'xrpl:1', asset: 'RLUSD' } },
      },
    });
    const cRes = makeRes();
    mw(makeReq() as any, cRes as any, () => {});
    await new Promise((r) => setTimeout(r, 0));
    const invoiceId = cRes._body.invoiceId as string;

    const accepted: XrplPaymentRequirements = {
      scheme: 'exact', network: 'xrpl:1', asset: RLUSD_HEX, payTo: 'rM',
      amount: '0.01', maxTimeoutSeconds: 600,
      extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId, issuer: RLUSD_ISSUERS.testnet },
    };
    const sig = buildSigEnvelope(accepted);

    // First settlement: ok.
    const firstRes = makeRes();
    let firstNext = false;
    mw(makeReq('GET', '/paid', { 'payment-signature': sig }) as any, firstRes as any, () => { firstNext = true; });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(firstNext).toBe(true);

    // Replay: same envelope, same invoiceId.
    const replayRes = makeRes();
    let replayNext = false;
    mw(makeReq('GET', '/paid', { 'payment-signature': sig }) as any, replayRes as any, () => { replayNext = true; });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(replayNext).toBe(false);
    expect(replayRes._status).toBe(402);
    expect(replayRes._body.error).toBe('invoice_already_consumed');
  });

  it('requirements mismatch (amount differs): 402 requirements_mismatch (no facilitator call)', async () => {
    const { createPaywall, clearXrplInvoiceCache } = await import('../src/middleware.js');
    clearXrplInvoiceCache();
    const fakeFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fakeFetch);

    const mw = createPaywall({
      routes: { 'GET /paid': { price: '0.01', xrpl: { payTo: 'rM', network: 'xrpl:1', asset: 'RLUSD' } } },
    });
    const cRes = makeRes();
    mw(makeReq() as any, cRes as any, () => {});
    await new Promise((r) => setTimeout(r, 0));
    const invoiceId = cRes._body.invoiceId as string;

    const accepted: XrplPaymentRequirements = {
      scheme: 'exact', network: 'xrpl:1', asset: RLUSD_HEX, payTo: 'rM',
      amount: '999', // <- mismatch
      maxTimeoutSeconds: 600,
      extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId, issuer: RLUSD_ISSUERS.testnet },
    };
    const sig = buildSigEnvelope(accepted);

    const r = makeRes();
    mw(makeReq('GET', '/paid', { 'payment-signature': sig }) as any, r as any, () => {});
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    expect(r._status).toBe(402);
    expect(r._body.error).toBe('requirements_mismatch');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('facilitator verify returns invalid: 402 verify_invalid with reason', async () => {
    const { createPaywall, clearXrplInvoiceCache } = await import('../src/middleware.js');
    clearXrplInvoiceCache();
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ isValid: false, invalidReason: 'amount_mismatch' }), { status: 200 }),
    ));

    const mw = createPaywall({
      routes: { 'GET /paid': { price: '0.01', xrpl: { payTo: 'rM', network: 'xrpl:1', asset: 'RLUSD' } } },
    });
    const cRes = makeRes();
    mw(makeReq() as any, cRes as any, () => {});
    await new Promise((r) => setTimeout(r, 0));
    const invoiceId = cRes._body.invoiceId as string;

    const accepted: XrplPaymentRequirements = {
      scheme: 'exact', network: 'xrpl:1', asset: RLUSD_HEX, payTo: 'rM',
      amount: '0.01', maxTimeoutSeconds: 600,
      extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId, issuer: RLUSD_ISSUERS.testnet },
    };
    const sig = buildSigEnvelope(accepted);

    const r = makeRes();
    mw(makeReq('GET', '/paid', { 'payment-signature': sig }) as any, r as any, () => {});
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    expect(r._status).toBe(402);
    expect(r._body.error).toBe('verify_invalid');
    expect(r._body.reason).toBe('amount_mismatch');
  });

  it('unknown invoiceId: 402 unknown_invoice', async () => {
    const { createPaywall, clearXrplInvoiceCache } = await import('../src/middleware.js');
    clearXrplInvoiceCache();
    const mw = createPaywall({
      routes: { 'GET /paid': { price: '0.01', xrpl: { payTo: 'rM', network: 'xrpl:1', asset: 'RLUSD' } } },
    });
    const accepted: XrplPaymentRequirements = {
      scheme: 'exact', network: 'xrpl:1', asset: RLUSD_HEX, payTo: 'rM',
      amount: '0.01', maxTimeoutSeconds: 600,
      extra: { sourceTag: DEFAULT_SOURCE_TAG, invoiceId: 'never-issued', issuer: RLUSD_ISSUERS.testnet },
    };
    const sig = buildSigEnvelope(accepted);
    const r = makeRes();
    mw(makeReq('GET', '/paid', { 'payment-signature': sig }) as any, r as any, () => {});
    await new Promise((res) => setTimeout(res, 0));
    await new Promise((res) => setTimeout(res, 0));
    expect(r._status).toBe(402);
    expect(r._body.error).toBe('unknown_invoice');
  });
});
