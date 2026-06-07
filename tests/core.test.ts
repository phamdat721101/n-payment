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
  const validOws = { wallet: 'test-agent', privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };

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

  it('accepts config without ows.privateKey (dual-mode OWS)', () => {
    const cfg = createConfig({ chains: ['base-sepolia'], ows: { wallet: 'test' } });
    expect(cfg.ows.wallet).toBe('test');
  });

  it('throws when goat chain used without credentials', () => {
    expect(() => createConfig({ chains: ['goat-testnet'], ows: validOws })).toThrow('GOAT chains require goat credentials');
  });

  it('accepts goat chain with credentials', () => {
    const cfg = createConfig({
      chains: ['goat-testnet'], ows: validOws,
      goat: { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
    });
    expect(cfg.goat?.apiKey).toBe('k');
  });

  it('accepts btcLending config with goat chain', () => {
    const cfg = createConfig({
      chains: ['goat-testnet'], ows: validOws,
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
      chains: ['goat-testnet'], ows: validOws,
      goat: { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      btcLending: { vaultAddress: '' },
    })).toThrow('vaultAddress is required');
  });
});

// ─── chains ──────────────────────────────────────────────────────────────────

describe('chains', () => {
  it('has all 28 chains', () => {
    expect(Object.keys(CHAINS)).toHaveLength(28);
  });

  it('getChain returns correct config', () => {
    expect(getChain('base-sepolia').chainId).toBe(84532);
    expect(getChain('goat-testnet').chainId).toBe(48816);
    expect(getChain('tempo-testnet').chainId).toBe(42431);
    expect(getChain('tempo-mainnet').chainId).toBe(4217);
  });

  it('getChainsForProtocol filters correctly', () => {
    const all: any[] = ['base-sepolia', 'arbitrum-sepolia', 'tempo-testnet'];
    expect(getChainsForProtocol(all, 'x402')).toEqual(['base-sepolia', 'arbitrum-sepolia']);
    expect(getChainsForProtocol(all, 'mpp')).toEqual(['tempo-testnet']);
  });

  it('goat chains include BTC tokens', () => {
    expect(getChain('goat-testnet').tokens.WBTC).toBeDefined();
    expect(getChain('goat-testnet').tokens.PegBTC).toBeDefined();
  });

  // ── v0.23 — Initia (Cosmos-SDK) ────────────────────────────────────────────
  it('initia chains registered with cosmos-msgsend protocol + correct caip2', () => {
    expect(getChain('initia-mainnet').caip2).toBe('cosmos:interwoven-1');
    expect(getChain('initia-testnet').caip2).toBe('cosmos:initiation-2');
    expect(getChain('initia-mainnet').protocols).toContain('cosmos-msgsend');
    expect(getChain('initia-testnet').protocols).toContain('cosmos-msgsend');
    expect(getChain('initia-mainnet').tokens.INIT).toBe('uinit');
  });
});

// ─── v0.23 — Initia asset registry ───────────────────────────────────────────

describe('initia assets (v0.23)', () => {
  it('getInitiaAsset normalizes case-insensitive symbols', async () => {
    const { getInitiaAsset } = await import('../src/initia/assets.js');
    expect(getInitiaAsset('initia-testnet', 'iusd').symbol).toBe('iUSD');
    expect(getInitiaAsset('initia-testnet', 'IUSD').symbol).toBe('iUSD');
    expect(getInitiaAsset('initia-testnet', 'iUSD').symbol).toBe('iUSD');
    expect(getInitiaAsset('initia-mainnet', 'init').symbol).toBe('INIT');
  });

  it('INIT denom is verified=true (uinit), iUSD is placeholder until env override', async () => {
    const { getInitiaAsset } = await import('../src/initia/assets.js');
    expect(getInitiaAsset('initia-testnet', 'INIT').verified).toBe(true);
    expect(getInitiaAsset('initia-testnet', 'INIT').denom).toBe('uinit');
    // No env var → placeholder
    delete process.env.INITIA_IUSD_DENOM_TESTNET;
    expect(getInitiaAsset('initia-testnet', 'iUSD').verified).toBe(false);
  });

  it('env override flips verified=true and replaces denom', async () => {
    process.env.INITIA_IUSD_DENOM_TESTNET = 'l2/test_iusd_denom_for_test';
    const { getInitiaAsset } = await import('../src/initia/assets.js');
    const a = getInitiaAsset('initia-testnet', 'iUSD');
    expect(a.denom).toBe('l2/test_iusd_denom_for_test');
    expect(a.verified).toBe(true);
    delete process.env.INITIA_IUSD_DENOM_TESTNET;
  });

  it('parseInitiaAmount / formatInitiaAmount round-trip 6-dec values', async () => {
    const { parseInitiaAmount, formatInitiaAmount } = await import('../src/initia/assets.js');
    expect(parseInitiaAmount('1.5')).toBe(1_500_000n);
    expect(parseInitiaAmount('0.000001')).toBe(1n);
    expect(formatInitiaAmount(1_500_000n)).toBe('1.5');
    expect(formatInitiaAmount(1_000_000n)).toBe('1');
  });

  it('selectIusdCorridor: direct hit when buyer has iUSD on requested chain', async () => {
    const { selectIusdCorridor } = await import('../src/initia/corridor.js');
    const r = selectIusdCorridor({
      requestedChain: 'initia-testnet',
      requestedAmount: 1_000_000n,
      iusdHoldings: { 'initia-testnet': 5_000_000n },
    });
    expect(r.kind).toBe('direct');
  });

  it('selectIusdCorridor: skip-api when buyer has USDC on Base Sepolia', async () => {
    const { selectIusdCorridor } = await import('../src/initia/corridor.js');
    const r = selectIusdCorridor({
      requestedChain: 'initia-testnet',
      requestedAmount: 1_000_000n,
      usdcHoldings: { 'base-sepolia': 5_000_000n },
      skipApiHealthy: true,
    });
    expect(r.kind).toBe('bridge');
    if (r.kind === 'bridge') {
      expect(r.corridor).toBe('skip-api');
      expect(r.steps[0].fromChain).toBe('base-sepolia');
    }
  });

  it('selectIusdCorridor: wormhole-ntt-fallback when Skip down', async () => {
    const { selectIusdCorridor } = await import('../src/initia/corridor.js');
    const r = selectIusdCorridor({
      requestedChain: 'initia-mainnet',
      requestedAmount: 1_000_000n,
      usdcHoldings: { 'base-mainnet': 5_000_000n },
      skipApiHealthy: false,
    });
    expect(r.kind).toBe('bridge');
    if (r.kind === 'bridge') expect(r.corridor).toBe('wormhole-ntt-fallback');
  });

  it('selectIusdCorridor: no-route when nothing matches', async () => {
    const { selectIusdCorridor } = await import('../src/initia/corridor.js');
    const r = selectIusdCorridor({
      requestedChain: 'initia-testnet',
      requestedAmount: 1_000_000n,
      usdcHoldings: {},
    });
    expect(r.kind).toBe('no-route');
  });

  it('LayerZeroAusdClient.bridge throws on testnet network', async () => {
    const { LayerZeroAusdClient } = await import('../src/initia/corridor.js');
    const lz = new LayerZeroAusdClient({});
    await expect(
      lz.bridge({ amount: 1n, recipient: 'init1...', network: 'testnet' }),
    ).rejects.toMatchObject({ code: 'LAYERZERO_AUSD_TESTNET_UNAVAILABLE' });
  });

  it('InitiaIusdAdapter.detect parses cosmos-msgsend challenge', async () => {
    const { InitiaIusdAdapter } = await import('../src/adapters/initia-iusd.js');
    const { InitiaClient } = await import('../src/initia/client.js');
    const ic = new InitiaClient({ chainKey: 'initia-testnet' });
    const adapter = new InitiaIusdAdapter(ic, 'initia-testnet');
    const challenge = Buffer.from(JSON.stringify({
      x402Version: 1, accepts: [{
        scheme: 'cosmos-msgsend', network: 'initiation-2', asset: 'iUSD',
        payTo: 'init1abc', maxAmountRequired: '10000',
      }],
    })).toString('base64');
    const r = new Response(null, { status: 402, headers: { 'payment-required': challenge } });
    expect(adapter.detect(r)).toBe(true);

    const xrplChallenge = Buffer.from(JSON.stringify({
      accepts: [{ scheme: 'xrpl', network: 'xrpl:mainnet' }],
    })).toString('base64');
    const r2 = new Response(null, { status: 402, headers: { 'payment-required': xrplChallenge } });
    expect(adapter.detect(r2)).toBe(false);
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
    expect(res._headers['www-authenticate']).toContain('intent="charge"');
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
