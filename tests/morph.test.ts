import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sortObjectDeep, signMorphRequest } from '../src/morph/auth.js';
import { MorphX402Client } from '../src/morph/client.js';
import { MorphX402Adapter } from '../src/adapters/morph-x402.js';
import { detectProtocol } from '../src/detect.js';
import { createConfig } from '../src/config.js';
import { createPaymentClient } from '../src/client.js';
import { createPaywall } from '../src/middleware.js';
import { AuditLog, SpendingGuard, PolicyEngine } from '../src/policy/index.js';
import { NPaymentError } from '../src/errors.js';
import type { OWSWallet } from '../src/ows/wallet.js';

// ─── HMAC Auth ───────────────────────────────────────────────────────────────

describe('sortObjectDeep', () => {
  it('sorts object keys lexicographically', () => {
    expect(JSON.stringify(sortObjectDeep({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('sorts nested objects recursively', () => {
    const out = JSON.stringify(sortObjectDeep({ z: { y: 1, x: 2 }, a: { c: 3, b: 4 } }));
    expect(out).toBe('{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}');
  });

  it('preserves array order but sorts inside array elements', () => {
    const out = JSON.stringify(sortObjectDeep([{ b: 1, a: 2 }, { d: 3, c: 4 }]));
    expect(out).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it('passes through primitives unchanged', () => {
    expect(sortObjectDeep(42)).toBe(42);
    expect(sortObjectDeep('x')).toBe('x');
    expect(sortObjectDeep(null)).toBe(null);
  });
});

describe('signMorphRequest', () => {
  it('returns three required Morph headers', () => {
    const headers = signMorphRequest({
      method: 'POST', path: '/x402/v2/settle',
      body: '{"x402Version":2}', accessKey: 'morph_ak_test', secretKey: 'morph_sk_test',
    });
    expect(headers['MORPH-ACCESS-KEY']).toBe('morph_ak_test');
    expect(headers['MORPH-ACCESS-TIMESTAMP']).toMatch(/^\d{13}$/);
    expect(headers['MORPH-ACCESS-SIGN']).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('produces deterministic signature for fixed timestamp', () => {
    const params = {
      method: 'POST', path: '/x402/v2/verify',
      body: '{"a":1,"b":2}', accessKey: 'k', secretKey: 's', timestamp: '1738056600000',
    };
    const a = signMorphRequest(params);
    const b = signMorphRequest(params);
    expect(a['MORPH-ACCESS-SIGN']).toBe(b['MORPH-ACCESS-SIGN']);
  });

  it('uppercases HTTP method in sign content', () => {
    const a = signMorphRequest({ method: 'post', path: '/x402/v2/verify', accessKey: 'k', secretKey: 's', timestamp: '1' });
    const b = signMorphRequest({ method: 'POST', path: '/x402/v2/verify', accessKey: 'k', secretKey: 's', timestamp: '1' });
    expect(a['MORPH-ACCESS-SIGN']).toBe(b['MORPH-ACCESS-SIGN']);
  });

  it('omits MORPH-ACCESS-BODY when body is empty (different signature than with body)', () => {
    const noBody = signMorphRequest({ method: 'GET', path: '/x402/v2/supported', accessKey: 'k', secretKey: 's', timestamp: '1' });
    const withBody = signMorphRequest({ method: 'GET', path: '/x402/v2/supported', body: '{}', accessKey: 'k', secretKey: 's', timestamp: '1' });
    expect(noBody['MORPH-ACCESS-SIGN']).not.toBe(withBody['MORPH-ACCESS-SIGN']);
  });
});

// ─── MorphX402Client ─────────────────────────────────────────────────────────

describe('MorphX402Client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ kinds: [], extensions: [] }), { status: 200 }),
    );
  });

  afterEach(() => fetchSpy.mockRestore());

  it('getSupported sends GET without auth headers', async () => {
    const client = new MorphX402Client();
    await client.getSupported();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).not.toHaveProperty('MORPH-ACCESS-KEY');
  });

  it('verify sends POST with HMAC headers when credentials provided', async () => {
    const client = new MorphX402Client({ accessKey: 'morph_ak_x', secretKey: 'morph_sk_y' });
    await client.verify({}, {});
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['MORPH-ACCESS-KEY']).toBe('morph_ak_x');
    expect(headers['MORPH-ACCESS-SIGN']).toBeTruthy();
  });

  it('verify throws MORPH_NO_CREDENTIALS when keys missing', async () => {
    const client = new MorphX402Client();
    await expect(client.verify({}, {})).rejects.toThrow(/MORPH_NO_CREDENTIALS|requires accessKey/);
  });

  it('maps 401 to MORPH_AUTH_FAILED', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ invalidReason: 'bad sig' }), { status: 401 }));
    const client = new MorphX402Client({ accessKey: 'k', secretKey: 's' });
    await expect(client.verify({}, {})).rejects.toMatchObject({ code: 'MORPH_AUTH_FAILED' });
  });

  it('maps 429 to MORPH_RATE_LIMITED', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ errorReason: 'rate limit exceeded' }), { status: 429 }));
    const client = new MorphX402Client({ accessKey: 'k', secretKey: 's' });
    await expect(client.settle({}, {})).rejects.toMatchObject({ code: 'MORPH_RATE_LIMITED' });
  });

  it('normalizes baseUrl whether it ends with /x402 or not', async () => {
    const c1 = new MorphX402Client({ baseUrl: 'https://example.com/x402' });
    const c2 = new MorphX402Client({ baseUrl: 'https://example.com' });
    await c1.getSupported();
    await c2.getSupported();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/x402/v2/supported');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://example.com/x402/v2/supported');
  });
});

// ─── MorphX402Adapter ────────────────────────────────────────────────────────

function makeMorph402Response(network = 'eip155:2818'): Response {
  const challenge = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network, asset: '0xUSDC', maxAmountRequired: '10000', payTo: '0xMerchant' }],
  })).toString('base64');
  return new Response(null, { status: 402, headers: { 'payment-required': challenge } });
}

function makeMockWallet(balance = 1_000_000n): OWSWallet {
  return {
    getBalance: vi.fn().mockResolvedValue(balance),
    getAddressAsync: vi.fn().mockResolvedValue('0xPayer'),
    transferERC20: vi.fn().mockResolvedValue({ txHash: '0xTX', blockNumber: 1n }),
  } as unknown as OWSWallet;
}

function makeMockClient(verifyValid = true, settleSuccess = true): MorphX402Client {
  return {
    verify: vi.fn().mockResolvedValue({ isValid: verifyValid, payer: '0xPayer', invalidReason: verifyValid ? '' : 'bad' }),
    settle: vi.fn().mockResolvedValue({
      success: settleSuccess, payer: '0xPayer',
      transaction: '0xTX', network: 'eip155:2818',
      errorReason: settleSuccess ? '' : 'failed',
    }),
  } as unknown as MorphX402Client;
}

describe('MorphX402Adapter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
  });

  afterEach(() => fetchSpy.mockRestore());

  it('detects Morph mainnet network in payment-required header', () => {
    const adapter = new MorphX402Adapter(makeMockWallet(), makeMockClient(), 'morph-mainnet');
    expect(adapter.detect(makeMorph402Response('eip155:2818'))).toBe(true);
    expect(adapter.detect(makeMorph402Response('eip155:8453'))).toBe(false);
  });

  it('completes full pay flow: verify → transfer → settle → retry', async () => {
    const wallet = makeMockWallet();
    const client = makeMockClient();
    const adapter = new MorphX402Adapter(wallet, client, 'morph-mainnet');
    const res = await adapter.pay('https://api.example.com/data', { method: 'GET' }, makeMorph402Response());
    expect(res.status).toBe(200);
    expect(client.verify).toHaveBeenCalledOnce();
    expect(wallet.transferERC20).toHaveBeenCalledOnce();
    expect(client.settle).toHaveBeenCalledOnce();
    const retryHeaders = (fetchSpy.mock.calls.at(-1)![1] as RequestInit).headers as Headers;
    expect(retryHeaders.get('x-payment-tx')).toBe('0xTX');
    expect(retryHeaders.get('x-payment-network')).toBe('eip155:2818');
  });

  it('threads referenceKey to retry header', async () => {
    const adapter = new MorphX402Adapter(makeMockWallet(), makeMockClient(), 'morph-mainnet');
    await adapter.pay('https://api.example.com/data', undefined, makeMorph402Response(), { referenceKey: 'ORD-001' });
    const retryHeaders = (fetchSpy.mock.calls.at(-1)![1] as RequestInit).headers as Headers;
    expect(retryHeaders.get('x-payment-reference-key')).toBe('ORD-001');
  });

  it('throws InsufficientBalanceError before facilitator call', async () => {
    const wallet = makeMockWallet(0n);
    const client = makeMockClient();
    const adapter = new MorphX402Adapter(wallet, client, 'morph-mainnet');
    await expect(adapter.pay('https://api.example.com/data', undefined, makeMorph402Response()))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('throws MORPH_VERIFY_FAILED before on-chain transfer', async () => {
    const wallet = makeMockWallet();
    const adapter = new MorphX402Adapter(wallet, makeMockClient(false), 'morph-mainnet');
    await expect(adapter.pay('https://api.example.com/data', undefined, makeMorph402Response()))
      .rejects.toMatchObject({ code: 'MORPH_VERIFY_FAILED' });
    expect(wallet.transferERC20).not.toHaveBeenCalled();
  });

  it('throws MORPH_SETTLE_FAILED after successful transfer (non-recoverable to caller)', async () => {
    const adapter = new MorphX402Adapter(makeMockWallet(), makeMockClient(true, false), 'morph-mainnet');
    await expect(adapter.pay('https://api.example.com/data', undefined, makeMorph402Response()))
      .rejects.toMatchObject({ code: 'MORPH_SETTLE_FAILED' });
  });

  it('throws ChallengeParseError on missing payment-required header', async () => {
    const adapter = new MorphX402Adapter(makeMockWallet(), makeMockClient(), 'morph-mainnet');
    await expect(adapter.pay('https://api.example.com/data', undefined, new Response(null, { status: 402 })))
      .rejects.toMatchObject({ code: 'MORPH_NO_CHALLENGE' });
  });
});

// ─── detectProtocol Morph routing ───────────────────────────────────────────

describe('detectProtocol — Morph', () => {
  it('returns morph-x402 for mainnet network', () => {
    expect(detectProtocol(makeMorph402Response('eip155:2818'))).toBe('morph-x402');
  });
  it('returns morph-x402 for Hoodi testnet network', () => {
    expect(detectProtocol(makeMorph402Response('eip155:2910'))).toBe('morph-x402');
  });
  it('falls back to x402 for non-Morph EVM networks', () => {
    expect(detectProtocol(makeMorph402Response('eip155:8453'))).toBe('x402');
  });
});

// ─── createConfig — AltFee guard ────────────────────────────────────────────

describe('createConfig — Morph', () => {
  const validOws = { wallet: 'test', privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };

  it('throws NOT_IMPLEMENTED when altFee.enabled', () => {
    expect(() => createConfig({
      chains: ['morph-mainnet'], ows: validOws,
      morph: { accessKey: 'k', secretKey: 's', altFee: { enabled: true } },
    })).toThrow(/NOT_IMPLEMENTED|AltFee/);
  });

  it('accepts morph chain with credentials', () => {
    const cfg = createConfig({
      chains: ['morph-mainnet'], ows: validOws,
      morph: { accessKey: 'morph_ak_x', secretKey: 'morph_sk_y' },
    });
    expect(cfg.morph?.accessKey).toBe('morph_ak_x');
  });

  it('accepts morph chain without credentials (credential-less mode)', () => {
    const cfg = createConfig({ chains: ['morph-mainnet'], ows: validOws });
    expect(cfg.chains).toContain('morph-mainnet');
  });
});

// ─── PaymentClient — soft credential-less + strict + adapter wiring ─────────

describe('createPaymentClient — Morph', () => {
  const validOws = { wallet: 'test', privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };

  it('warns and skips Morph adapter when credentials missing (soft mode)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createPaymentClient({ chains: ['morph-mainnet'], ows: validOws });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Morph chain configured without accessKey'));
    warn.mockRestore();
  });

  it('throws in strict mode when credentials missing', () => {
    expect(() => createPaymentClient({
      chains: ['morph-mainnet'], ows: validOws, morph: { strict: true },
    })).toThrow(/MORPH_NO_CREDENTIALS|strict/);
  });

  it('does not warn when credentials present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createPaymentClient({
      chains: ['morph-mainnet'], ows: validOws,
      morph: { accessKey: 'morph_ak_x', secretKey: 'morph_sk_y' },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── AuditLog referenceKey threading ────────────────────────────────────────

describe('AuditLog — referenceKey', () => {
  it('queryByReferenceKey returns matching entries', () => {
    const audit = new AuditLog();
    audit.record({ type: 'payment', amount: 1000n, chain: 'morph-mainnet', referenceKey: 'ORD-1', decision: { allowed: true } });
    audit.record({ type: 'payment', amount: 2000n, chain: 'morph-mainnet', referenceKey: 'ORD-2', decision: { allowed: true } });
    audit.record({ type: 'payment', amount: 3000n, chain: 'morph-mainnet', referenceKey: 'ORD-1', decision: { allowed: true } });
    const entries = audit.queryByReferenceKey('ORD-1');
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.referenceKey === 'ORD-1')).toBe(true);
  });

  it('SpendingGuard.recordPayment persists referenceKey + metadata', () => {
    const guard = new SpendingGuard(new PolicyEngine([]), new AuditLog());
    guard.recordPayment({
      url: 'https://x.com', amount: 500n, chain: 'morph-mainnet',
      referenceKey: 'ORD-7', metadata: { customer: 'alice' },
    });
    const [entry] = guard.getAudit().queryByReferenceKey('ORD-7');
    expect(entry.referenceKey).toBe('ORD-7');
    expect(entry.metadata).toEqual({ customer: 'alice' });
  });
});

// ─── Middleware — Morph paywall ─────────────────────────────────────────────

describe('createPaywall — Morph', () => {
  const config = {
    routes: { 'GET /api': { price: '10000', morph: { payTo: '0xPayee' } } },
  };

  const mockRes = () => {
    const headers: Record<string, string> = {};
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (c: number) => { res._status = c; return res; },
      json: (b: any) => { res._body = b; },
      _headers: headers, _status: 0, _body: null,
    };
    return res;
  };

  it('emits Morph payment-required challenge with eip155:2818 default', () => {
    const mw = createPaywall(config);
    const res = mockRes();
    mw({ method: 'GET', path: '/api', headers: {}, hostname: 'h' } as any, res, () => {});
    expect(res._status).toBe(402);
    expect(res._body.protocols).toContain('morph-x402');
    const decoded = JSON.parse(Buffer.from(res._headers['payment-required'], 'base64').toString());
    expect(decoded.accepts[0].network).toBe('eip155:2818');
    expect(decoded.accepts[0].payTo).toBe('0xPayee');
  });

  it('accepts request with valid Morph proof headers', () => {
    const mw = createPaywall(config);
    let nextCalled = false;
    mw(
      { method: 'GET', path: '/api', headers: { 'x-payment-tx': '0xTX', 'x-payment-network': 'eip155:2818' } } as any,
      mockRes(),
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
  });

  it('rejects request with wrong network in proof header', () => {
    const mw = createPaywall(config);
    const res = mockRes();
    mw(
      { method: 'GET', path: '/api', headers: { 'x-payment-tx': '0xTX', 'x-payment-network': 'eip155:8453' } } as any,
      res, () => {},
    );
    expect(res._status).toBe(402);
  });
});
