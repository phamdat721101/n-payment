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

// ─── v0.18: Hoodi chain config + routing ────────────────────────────────────

describe('Morph Hoodi Testnet — chain config (v0.18)', () => {
  it('has chainId 2910 and CAIP-2 eip155:2910', async () => {
    const { CHAINS } = await import('../src/chains.js');
    expect(CHAINS['morph-hoodi-testnet'].chainId).toBe(2910);
    expect(CHAINS['morph-hoodi-testnet'].caip2).toBe('eip155:2910');
  });

  it('uses operator-supplied USDC at 0x7433…b661B', async () => {
    const { CHAINS } = await import('../src/chains.js');
    expect(CHAINS['morph-hoodi-testnet'].tokens.USDC).toBe('0x7433b41C6c5e1d58D4Da99483609520255ab661B');
  });

  it('uses canonical Hoodi RPC https://rpc-hoodi.morph.network', async () => {
    const { CHAINS } = await import('../src/chains.js');
    expect(CHAINS['morph-hoodi-testnet'].rpcUrl).toBe('https://rpc-hoodi.morph.network');
  });

  it('MorphX402Adapter constructed with morph-hoodi-testnet detects a Hoodi 402', () => {
    const adapter = new MorphX402Adapter(makeMockWallet(), makeMockClient(), 'morph-hoodi-testnet');
    expect(adapter.detect(makeMorph402Response('eip155:2910'))).toBe(true);
    expect(adapter.detect(makeMorph402Response('eip155:2818'))).toBe(false);
  });
});

// ─── v0.18: EIP-3009 helpers ────────────────────────────────────────────────

describe('eip3009 helpers (v0.18)', () => {
  const auth = {
    from: '0x1111111111111111111111111111111111111111' as const,
    to: '0x2222222222222222222222222222222222222222' as const,
    value: 10_000n,
    validAfter: 0n,
    validBefore: 9_999_999_999n,
    nonce: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const,
  };

  it('buildTransferWithAuthorizationTypedData produces EIP-712 shape with Circle defaults', async () => {
    const { buildTransferWithAuthorizationTypedData } = await import('../src/morph/eip3009.js');
    const td = buildTransferWithAuthorizationTypedData({
      verifyingContract: '0x7433b41C6c5e1d58D4Da99483609520255ab661B',
      chainId: 2910,
      authorization: auth,
    });
    expect(td.domain.name).toBe('USD Coin');
    expect(td.domain.version).toBe('2');
    expect(td.domain.chainId).toBe(2910);
    expect(td.primaryType).toBe('TransferWithAuthorization');
    expect(td.types.TransferWithAuthorization).toHaveLength(6);
  });

  it('randomEip3009Nonce returns 0x + 64 hex chars', async () => {
    const { randomEip3009Nonce } = await import('../src/morph/eip3009.js');
    const n = randomEip3009Nonce();
    expect(n).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomEip3009Nonce()).not.toBe(n); // randomness sanity
  });

  it('encode/decode authorization is a clean roundtrip', async () => {
    const { encodeAuthorizationPayload, decodeAuthorizationPayload } = await import('../src/morph/eip3009.js');
    const wire = encodeAuthorizationPayload(auth);
    expect(wire.value).toBe('10000');
    const back = decodeAuthorizationPayload(wire);
    expect(back).toEqual(auth);
  });

  it('decodeAuthorizationPayload throws on malformed input', async () => {
    const { decodeAuthorizationPayload } = await import('../src/morph/eip3009.js');
    expect(() => decodeAuthorizationPayload(null)).toThrow();
    expect(() => decodeAuthorizationPayload({ from: '0xa', to: '0xb', value: 1 })).toThrow();
  });

  it('splitSignature decomposes 65-byte sig into v/r/s', async () => {
    const { splitSignature } = await import('../src/morph/eip3009.js');
    const sig = ('0x' + 'a'.repeat(64) + 'b'.repeat(64) + '1c') as `0x${string}`;
    const { v, r, s } = splitSignature(sig);
    expect(v).toBe(28);
    expect(r).toBe('0x' + 'a'.repeat(64));
    expect(s).toBe('0x' + 'b'.repeat(64));
  });

  it('OWSWallet.signTypedData with privateKey produces a recoverable EIP-712 signature', async () => {
    const { OWSWallet } = await import('../src/ows/wallet.js');
    const { buildTransferWithAuthorizationTypedData } = await import('../src/morph/eip3009.js');
    const { recoverTypedDataAddress, privateKeyToAccount } = await import('viem/accounts').then(async (m) => ({
      privateKeyToAccount: m.privateKeyToAccount,
      recoverTypedDataAddress: (await import('viem')).recoverTypedDataAddress,
    }));
    const pk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
    const expected = privateKeyToAccount(pk).address;
    const wallet = new OWSWallet({ wallet: 'test', privateKey: pk });
    const td = buildTransferWithAuthorizationTypedData({
      verifyingContract: '0x7433b41C6c5e1d58D4Da99483609520255ab661B',
      chainId: 2910,
      authorization: { ...auth, from: expected },
    });
    const sig = await wallet.signTypedData({
      domain: td.domain, types: td.types, primaryType: 'TransferWithAuthorization',
      message: td.message as unknown as Record<string, unknown>,
    });
    const recovered = await recoverTypedDataAddress({
      domain: td.domain, types: td.types, primaryType: 'TransferWithAuthorization',
      message: td.message, signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('OWSWallet.signTypedData throws NO_TYPED_DATA_SIGNER without privateKey', async () => {
    const { OWSWallet } = await import('../src/ows/wallet.js');
    const wallet = new OWSWallet({ wallet: 'test' });
    await expect(wallet.signTypedData({
      domain: { chainId: 2910 },
      types: { Foo: [{ name: 'x', type: 'uint256' }] },
      primaryType: 'Foo',
      message: { x: 1n },
    })).rejects.toMatchObject({ code: 'NO_TYPED_DATA_SIGNER' });
  });
});

// ─── v0.18: Hoodi facilitator ───────────────────────────────────────────────

describe('createMorphHoodiFacilitator (v0.18)', () => {
  const USDC = '0x7433b41C6c5e1d58D4Da99483609520255ab661B' as const;
  const SPONSOR = '0x9999999999999999999999999999999999999999' as const;
  const buyerPk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

  // Build a signed authorization for the test buyer
  async function signAuthForTest(opts: { value?: bigint; validBefore?: bigint; nonce?: `0x${string}` } = {}) {
    const { privateKeyToAccount } = await import('viem/accounts');
    const { buildTransferWithAuthorizationTypedData, randomEip3009Nonce, encodeAuthorizationPayload } =
      await import('../src/morph/eip3009.js');
    const account = privateKeyToAccount(buyerPk);
    const auth = {
      from: account.address,
      to: '0x000000000000000000000000000000000000beef' as const,
      value: opts.value ?? 10_000n,
      validAfter: 0n,
      validBefore: opts.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 300),
      nonce: opts.nonce ?? randomEip3009Nonce(),
    };
    const td = buildTransferWithAuthorizationTypedData({
      verifyingContract: USDC, chainId: 2910, authorization: auth,
    });
    const signature = await account.signTypedData({
      domain: td.domain, types: td.types, primaryType: 'TransferWithAuthorization', message: td.message,
    });
    return {
      paymentRequirements: {
        scheme: 'eip3009', network: 'eip155:2910', asset: USDC,
        maxAmountRequired: '10000', payTo: auth.to,
      },
      paymentPayload: { authorization: encodeAuthorizationPayload(auth), signature },
      auth, signature, account,
    };
  }

  // Deterministic mock req/res shells
  function mkReq(opts: { method: string; path: string; body?: unknown; headers?: Record<string, string> }) {
    return { method: opts.method, path: opts.path, body: opts.body, headers: opts.headers ?? {} };
  }
  function mkRes() {
    const out: { status?: number; body?: unknown } = {};
    const res = {
      status(code: number) { out.status = code; return res; },
      json(b: unknown) { out.body = b; return res; },
      out,
    };
    return res;
  }

  function mkPublicClient(authorizationStateValue = false, throwOnRead = false) {
    return {
      chain: { id: 2910 },
      async readContract() {
        if (throwOnRead) throw new Error('rpc unavailable');
        return authorizationStateValue;
      },
      async waitForTransactionReceipt() { return { status: 'success' as const }; },
    } as never;
  }

  function mkSponsorClient(txHash = '0xfacefacefacefacefacefacefacefacefacefacefacefacefacefacefaceface') {
    return {
      chain: { id: 2910 },
      account: { address: SPONSOR },
      async writeContract() { return txHash; },
    } as never;
  }

  it('GET /x402/v2/supported returns the eip3009 kind without auth', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const res = mkRes();
    await handler(mkReq({ method: 'GET', path: '/x402/v2/supported' }), res);
    expect(res.out.status).toBe(200);
    expect((res.out.body as any).kinds[0]).toMatchObject({ scheme: 'eip3009', network: 'eip155:2910' });
  });

  it('POST /v2/verify accepts a valid authorization and returns isValid:true', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const { paymentRequirements, paymentPayload, account } = await signAuthForTest();
    const res = mkRes();
    await handler(mkReq({ method: 'POST', path: '/x402/v2/verify', body: { paymentRequirements, paymentPayload } }), res);
    expect(res.out.status).toBe(200);
    expect((res.out.body as any).isValid).toBe(true);
    expect(((res.out.body as any).payer as string).toLowerCase()).toBe(account.address.toLowerCase());
  });

  it('POST /v2/verify rejects expired authorization', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const { paymentRequirements, paymentPayload } = await signAuthForTest({ validBefore: 1n });
    const res = mkRes();
    await handler(mkReq({ method: 'POST', path: '/x402/v2/verify', body: { paymentRequirements, paymentPayload } }), res);
    expect((res.out.body as any).code).toBe('AUTH_EXPIRED');
  });

  it('POST /v2/verify rejects amount-too-low', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const { paymentRequirements, paymentPayload } = await signAuthForTest({ value: 1n });
    const res = mkRes();
    await handler(mkReq({ method: 'POST', path: '/x402/v2/verify', body: { paymentRequirements, paymentPayload } }), res);
    expect((res.out.body as any).code).toBe('AMOUNT_TOO_LOW');
  });

  it('POST /v2/settle submits on-chain and returns txHash, then rejects replay', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const { paymentRequirements, paymentPayload } = await signAuthForTest();
    const res1 = mkRes();
    await handler(mkReq({ method: 'POST', path: '/x402/v2/settle', body: { paymentRequirements, paymentPayload } }), res1);
    expect(res1.out.status).toBe(200);
    expect((res1.out.body as any).success).toBe(true);
    expect((res1.out.body as any).transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect((res1.out.body as any).network).toBe('eip155:2910');

    // Replay: same nonce → 409
    const res2 = mkRes();
    await handler(mkReq({ method: 'POST', path: '/x402/v2/settle', body: { paymentRequirements, paymentPayload } }), res2);
    expect(res2.out.status).toBe(409);
    expect((res2.out.body as any).code).toBe('MORPH_NONCE_REPLAYED');
  });

  it('POST /v2/settle rejects when on-chain authorizationState is true', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(/* used */ true),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const { paymentRequirements, paymentPayload } = await signAuthForTest();
    const res = mkRes();
    await handler(mkReq({ method: 'POST', path: '/x402/v2/settle', body: { paymentRequirements, paymentPayload } }), res);
    expect((res.out.body as any).code).toBe('AUTHORIZATION_USED');
  });

  it('rejects request when HMAC required and missing', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
      accessKey: 'morph_ak_test', secretKey: 'morph_sk_test',
    });
    const { paymentRequirements, paymentPayload } = await signAuthForTest();
    const res = mkRes();
    await handler(mkReq({
      method: 'POST', path: '/x402/v2/verify',
      body: { paymentRequirements, paymentPayload },
      headers: {}, // no MORPH-ACCESS-* headers
    }), res);
    expect(res.out.status).toBe(401);
  });

  it('returns 404 for unknown route', async () => {
    const { createMorphHoodiFacilitator } = await import('../src/morph/facilitator.js');
    const handler = createMorphHoodiFacilitator({
      usdcAddress: USDC, publicClient: mkPublicClient(),
      sponsorClient: mkSponsorClient(), sponsorAddress: SPONSOR,
    });
    const res = mkRes();
    await handler(mkReq({ method: 'GET', path: '/something/else' }), res);
    expect(res.out.status).toBe(404);
  });
});

// ─── v0.18: MorphX402Adapter sponsored path ─────────────────────────────────

function makeMorph402ResponseEip3009(network = 'eip155:2910', payTo = '0x000000000000000000000000000000000000beef') {
  const challenge = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'eip3009', network, asset: '0x7433b41C6c5e1d58D4Da99483609520255ab661B', maxAmountRequired: '10000', payTo }],
  })).toString('base64');
  return new Response(null, { status: 402, headers: { 'payment-required': challenge } });
}

describe('MorphX402Adapter — eip3009 sponsored (v0.18)', () => {
  const buyerPk = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  function mkSponsoredWallet(balance = 1_000_000n) {
    return {
      getBalance: vi.fn().mockResolvedValue(balance),
      getAddressAsync: vi.fn().mockResolvedValue('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'),
      signTypedData: vi.fn().mockResolvedValue(`0x${'a'.repeat(64)}${'b'.repeat(64)}1c`),
      // transferERC20 must NOT be called in sponsored mode
      transferERC20: vi.fn().mockRejectedValue(new Error('transferERC20 must not be called in sponsored mode')),
    } as unknown as OWSWallet;
  }

  function mkSponsoredClient() {
    return {
      verify: vi.fn().mockResolvedValue({ isValid: true, payer: '0xPayer' }),
      settle: vi.fn().mockResolvedValue({
        success: true, payer: '0xPayer',
        transaction: '0xfacefacefacefacefacefacefacefacefacefacefacefacefacefacefaceface',
        network: 'eip155:2910',
      }),
    } as unknown as MorphX402Client;
  }

  it('takes the sponsored branch when scheme=eip3009, never calls transferERC20', async () => {
    const wallet = mkSponsoredWallet();
    const client = mkSponsoredClient();
    const adapter = new MorphX402Adapter(wallet, client, 'morph-hoodi-testnet');
    const res = await adapter.pay('https://api.example.com/x', { method: 'GET' }, makeMorph402ResponseEip3009());
    expect(res.status).toBe(200);
    expect(wallet.signTypedData).toHaveBeenCalledOnce();
    expect(wallet.transferERC20).not.toHaveBeenCalled();
    expect(client.verify).toHaveBeenCalledOnce();
    expect(client.settle).toHaveBeenCalledOnce();
    const retryHeaders = (fetchSpy.mock.calls.at(-1)![1] as RequestInit).headers as Headers;
    expect(retryHeaders.get('x-payment-tx')).toMatch(/^0xface/);
    expect(retryHeaders.get('x-payment-network')).toBe('eip155:2910');
  });

  it('threads referenceKey to retry headers in sponsored mode', async () => {
    const adapter = new MorphX402Adapter(mkSponsoredWallet(), mkSponsoredClient(), 'morph-hoodi-testnet');
    await adapter.pay('https://api.example.com/x', undefined, makeMorph402ResponseEip3009(), { referenceKey: 'ORD-9' });
    const retryHeaders = (fetchSpy.mock.calls.at(-1)![1] as RequestInit).headers as Headers;
    expect(retryHeaders.get('x-payment-reference-key')).toBe('ORD-9');
  });

  it('throws InsufficientBalanceError before signing', async () => {
    const wallet = mkSponsoredWallet(0n);
    const client = mkSponsoredClient();
    const adapter = new MorphX402Adapter(wallet, client, 'morph-hoodi-testnet');
    await expect(adapter.pay('https://api.example.com/x', undefined, makeMorph402ResponseEip3009()))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(wallet.signTypedData).not.toHaveBeenCalled();
  });

  it('mainnet 402 with default scheme still uses direct branch (regression)', async () => {
    const wallet = makeMockWallet();
    const client = makeMockClient();
    const adapter = new MorphX402Adapter(wallet, client, 'morph-mainnet');
    await adapter.pay('https://api.example.com/x', undefined, makeMorph402Response('eip155:2818'));
    expect(wallet.transferERC20).toHaveBeenCalledOnce();
  });

  it('round-trips a real EIP-712 signature against a real LocalAccount through the sponsored branch', async () => {
    const { OWSWallet } = await import('../src/ows/wallet.js');
    const wallet = new OWSWallet({ wallet: 'test', privateKey: buyerPk });
    // Stub balance so the pre-check passes without real RPC
    vi.spyOn(wallet, 'getBalance').mockResolvedValue(1_000_000n);
    const client = mkSponsoredClient();
    const adapter = new MorphX402Adapter(wallet, client, 'morph-hoodi-testnet');
    const res = await adapter.pay('https://api.example.com/x', undefined, makeMorph402ResponseEip3009());
    expect(res.status).toBe(200);
    // verify() got an authorization payload (not a txHash payload)
    const verifyArg = (client.verify as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(verifyArg.scheme).toBe('eip3009');
    expect(verifyArg.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(verifyArg.payload.authorization.from).toBeTruthy();
  });
});

// ─── v0.18: createPaywall scheme handling ───────────────────────────────────

describe('createPaywall — Morph scheme (v0.18)', () => {
  function decodeChallenge(headers: Record<string, string>) {
    return JSON.parse(Buffer.from(headers['payment-required'], 'base64').toString());
  }
  const mockRes2 = () => {
    const headers: Record<string, string> = {};
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (c: number) => { res._status = c; return res; },
      json: (b: any) => { res._body = b; },
      _headers: headers, _status: 0, _body: null,
    };
    return res;
  };

  it('emits scheme=exact by default for morph routes', () => {
    const mw = createPaywall({ routes: { 'GET /a': { price: '5000', morph: { payTo: '0xPayee' } } } });
    const res = mockRes2();
    mw({ method: 'GET', path: '/a', headers: {}, hostname: 'h' } as any, res, () => {});
    const decoded = decodeChallenge(res._headers);
    expect(decoded.accepts[0].scheme).toBe('exact');
  });

  it('emits scheme=eip3009 when route.morph.scheme is set', () => {
    const mw = createPaywall({
      routes: { 'GET /b': { price: '5000', morph: { payTo: '0xPayee', scheme: 'eip3009', network: 'eip155:2910' } } },
    });
    const res = mockRes2();
    mw({ method: 'GET', path: '/b', headers: {}, hostname: 'h' } as any, res, () => {});
    const decoded = decodeChallenge(res._headers);
    expect(decoded.accepts[0].scheme).toBe('eip3009');
    expect(decoded.accepts[0].network).toBe('eip155:2910');
  });
});
