import { describe, it, expect } from 'vitest';
import { detectProtocol } from '../src/detect.js';
import { createConfig } from '../src/config.js';
import { NPaymentError } from '../src/errors.js';
import { CHAINS, getChain, getChainsForProtocol } from '../src/chains.js';

// ─── detectProtocol ──────────────────────────────────────────────────────────

describe('detectProtocol', () => {
  const makeResponse = (headers: Record<string, string>) =>
    new Response(null, { status: 402, headers });

  it('detects x402 from payment-required header', () => {
    expect(detectProtocol(makeResponse({ 'payment-required': 'base64data' }))).toBe('x402');
  });

  it('detects mpp from www-authenticate header', () => {
    expect(detectProtocol(makeResponse({ 'www-authenticate': 'Payment realm="test"' }))).toBe('mpp');
  });

  it('returns x402 by default when both present', () => {
    expect(detectProtocol(makeResponse({
      'payment-required': 'base64data',
      'www-authenticate': 'Payment realm="test"',
    }))).toBe('x402');
  });

  it('respects mpp preference when both present', () => {
    expect(detectProtocol(makeResponse({
      'payment-required': 'base64data',
      'www-authenticate': 'Payment realm="test"',
    }), 'mpp')).toBe('mpp');
  });

  it('returns unknown when no payment headers', () => {
    expect(detectProtocol(makeResponse({}))).toBe('unknown');
  });
});

// ─── createConfig ────────────────────────────────────────────────────────────

describe('createConfig', () => {
  const validOws = { wallet: 'test-agent' };

  it('creates valid config with defaults', () => {
    const cfg = createConfig({ chains: ['base-sepolia'], ows: validOws });
    expect(cfg.protocol).toBe('auto');
    expect(cfg.ows.wallet).toBe('test-agent');
  });

  it('throws on empty chains', () => {
    expect(() => createConfig({ chains: [], ows: validOws })).toThrow(NPaymentError);
  });

  it('throws on unknown chain', () => {
    expect(() => createConfig({ chains: ['unknown-chain' as any], ows: validOws })).toThrow('Unknown chain');
  });

  it('throws on missing ows.wallet', () => {
    expect(() => createConfig({ chains: ['base-sepolia'], ows: { wallet: '' } })).toThrow('ows.wallet');
  });

  it('throws migration error for old privateKey config', () => {
    const oldConfig = { chains: ['base-sepolia'], privateKey: '0x123' };
    expect(() => createConfig(oldConfig as any)).toThrow('no longer supported');
  });

  it('throws when goat chain used without credentials', () => {
    expect(() => createConfig({ chains: ['goat-mainnet'], ows: validOws })).toThrow('GOAT chains require goat credentials');
  });

  it('accepts goat chain with credentials', () => {
    const cfg = createConfig({
      chains: ['goat-mainnet'], ows: validOws,
      goat: { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
    });
    expect(cfg.goat?.apiKey).toBe('k');
  });

  it('accepts btcLending config with goat chain', () => {
    const cfg = createConfig({
      chains: ['goat-mainnet'], ows: validOws,
      goat: { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      btcLending: { vaultAddress: '0xVAULT' },
    });
    expect(cfg.btcLending?.vaultAddress).toBe('0xVAULT');
  });

  it('throws when btcLending used without goat chain', () => {
    expect(() => createConfig({
      chains: ['base-sepolia'], ows: validOws,
      btcLending: { vaultAddress: '0xVAULT' },
    })).toThrow('btcLending requires a GOAT chain');
  });

  it('throws when btcLending missing vaultAddress', () => {
    expect(() => createConfig({
      chains: ['goat-mainnet'], ows: validOws,
      goat: { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      btcLending: { vaultAddress: '' },
    })).toThrow('vaultAddress is required');
  });
});

// ─── chains ──────────────────────────────────────────────────────────────────

describe('chains', () => {
  it('has all 5 chains', () => {
    expect(Object.keys(CHAINS)).toHaveLength(5);
  });

  it('getChain returns correct config', () => {
    expect(getChain('base-sepolia').chainId).toBe(84532);
    expect(getChain('goat-mainnet').chainId).toBe(2345);
  });

  it('getChainsForProtocol filters correctly', () => {
    const all: any[] = ['base-sepolia', 'arbitrum-sepolia', 'tempo-testnet'];
    expect(getChainsForProtocol(all, 'x402')).toEqual(['base-sepolia', 'arbitrum-sepolia']);
    expect(getChainsForProtocol(all, 'mpp')).toEqual(['tempo-testnet']);
  });

  it('goat chains include BTC tokens', () => {
    expect(getChain('goat-mainnet').tokens.WBTC).toBeDefined();
    expect(getChain('goat-mainnet').tokens.PegBTC).toBeDefined();
    expect(getChain('goat-testnet').tokens.WBTC).toBeDefined();
  });
});

// ─── middleware ───────────────────────────────────────────────────────────────

import { createPaywall, createHealthEndpoint } from '../src/middleware.js';

describe('createPaywall', () => {
  const config = {
    routes: {
      'GET /api/data': {
        price: '10000',
        x402: { payTo: '0xabc' },
        mpp: { currency: '0x20c0', recipient: '0xdef' },
      },
    },
  };

  const mockRes = () => {
    const headers: Record<string, string> = {};
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status: (code: number) => { res._status = code; return res; },
      json: (body: any) => { res._body = body; },
      _status: 0, _body: null, _headers: headers,
    };
    return res;
  };

  it('calls next() for unconfigured routes', () => {
    const mw = createPaywall(config);
    let called = false;
    mw({ method: 'GET', path: '/other', headers: {} } as any, mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });

  it('returns 402 with both challenges when no payment', () => {
    const mw = createPaywall(config);
    const res = mockRes();
    mw({ method: 'GET', path: '/api/data', headers: {}, hostname: 'test' } as any, res, () => {});
    expect(res._status).toBe(402);
    expect(res._headers['payment-required']).toBeDefined();
    expect(res._headers['www-authenticate']).toContain('Payment');
    expect(res._body.protocols).toEqual(['x402', 'mpp']);
  });

  it('calls next() when x402 payment-signature present', () => {
    const mw = createPaywall(config);
    let called = false;
    mw({ method: 'GET', path: '/api/data', headers: { 'payment-signature': 'sig' } } as any, mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });

  it('calls next() when MPP Authorization present', () => {
    const mw = createPaywall(config);
    let called = false;
    mw({ method: 'GET', path: '/api/data', headers: { authorization: 'Payment cred123' } } as any, mockRes(), () => { called = true; });
    expect(called).toBe(true);
  });
});

describe('createHealthEndpoint', () => {
  it('returns routes with pricing', () => {
    const config = { routes: { 'GET /api/data': { price: '10000', x402: { payTo: '0xabc' } } } };
    const res = { status: (c: number) => res, json: (b: any) => { (res as any)._body = b; } } as any;
    createHealthEndpoint(config)({} as any, res);
    expect(res._body.status).toBe('ok');
    expect(res._body.routes).toHaveLength(1);
  });
});
