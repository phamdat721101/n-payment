import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CHAINS, getChainsForProtocol } from '../src/chains.js';
import { createConfig } from '../src/config.js';
import { createPaymentClient } from '../src/client.js';
import { NPaymentError } from '../src/errors.js';
import {
  KeypairSpaceRouterSigner,
  spaceRouterDomain, SPACEROUTER_RECEIPT_TYPES,
} from '../src/spacerouter/signer.js';
import {
  SpaceRouterGatewayClient, SpaceRouterReceiptScheduler,
} from '../src/spacerouter/gateway.js';
import { SpaceRouterAdapter } from '../src/adapters/spacerouter.js';
import { SpaceRouterClient, SpaceRouterPeerDepMissingError } from '../src/spacerouter/client.js';
import { PolicyEngine, AuditLog, SpendingGuard } from '../src/policy/index.js';
import { recoverTypedDataAddress, type Hex } from 'viem';

const TEST_PK: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ESCROW: Hex = '0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0';

// ─── Chain registry ─────────────────────────────────────────────────────────

describe('chains.ts — Creditcoin entries', () => {
  it('exposes creditcoin-mainnet and creditcoin-testnet under spacerouter protocol', () => {
    expect(CHAINS['creditcoin-mainnet']?.protocols).toContain('spacerouter');
    expect(CHAINS['creditcoin-testnet']?.protocols).toContain('spacerouter');
    expect(getChainsForProtocol(['creditcoin-mainnet', 'morph-mainnet'], 'spacerouter')).toEqual(['creditcoin-mainnet']);
  });
});

// ─── Config validation ─────────────────────────────────────────────────────

describe('createConfig — SpaceRouter pairing', () => {
  it('passes when creditcoin chain + spacerouter config are present', () => {
    const cfg = createConfig({
      chains: ['creditcoin-testnet'],
      ows: { wallet: 'test' },
      spacerouter: { gatewayUrl: 'https://gateway.example' },
    });
    expect(cfg.chains).toContain('creditcoin-testnet');
  });

  it('throws when spacerouter.strict but no creditcoin chain', () => {
    expect(() => createConfig({
      chains: ['base-mainnet'],
      ows: { wallet: 'test' },
      spacerouter: { gatewayUrl: 'x', strict: true },
    })).toThrow(NPaymentError);
  });
});

// ─── Signer ────────────────────────────────────────────────────────────────

describe('KeypairSpaceRouterSigner', () => {
  it('returns lower-cased consumer address', async () => {
    const signer = new KeypairSpaceRouterSigner(TEST_PK);
    expect((await signer.getAddress()).toLowerCase()).toBe(TEST_ADDR);
  });

  it('produces an EIP-712 signature that recovers to the signer address', async () => {
    const signer = new KeypairSpaceRouterSigner(TEST_PK);
    const domain = spaceRouterDomain(102030, ESCROW);
    const message = {
      consumer: TEST_ADDR as Hex,
      gateway: '0x000000000000000000000000000000000000beef' as Hex,
      requestUuid: '0x12345678901234567890123456789012' as Hex,
      bytesServed: 1024n,
      priceWei: 1_000_000_000_000_000n, // 0.001 SPACE
      expiresAt: 1_800_000_000n,
    };
    const sig = await signer.signReceipt(domain, message);
    const recovered = await recoverTypedDataAddress({
      domain, types: SPACEROUTER_RECEIPT_TYPES, primaryType: 'Receipt',
      message, signature: sig,
    });
    expect(recovered.toLowerCase()).toBe(TEST_ADDR);
  });
});

// ─── Gateway client ────────────────────────────────────────────────────────

describe('SpaceRouterGatewayClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => { fetchMock = vi.fn(); });

  it('GETs /auth/challenge and parses the response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      challenge: '0xabc', gateway: '0xdead', requestUuid: '0xfeed',
      expiresAt: 1_800_000_000, priceWeiPerGB: '1000', bytesEstimate: 4096,
    }), { status: 200 }));
    const gw = new SpaceRouterGatewayClient({ mgmtUrl: 'https://gw:8081', fetch: fetchMock as unknown as typeof fetch });
    const ch = await gw.requestChallenge('0xabc');
    expect(ch.challenge).toBe('0xabc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][0] as string)).toContain('/auth/challenge?consumer=0xabc');
  });

  it('maps 503 to SR_NO_PROVIDERS code', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"no node"}', { status: 503 }));
    const gw = new SpaceRouterGatewayClient({ mgmtUrl: 'https://gw:8081', fetch: fetchMock as unknown as typeof fetch });
    await expect(gw.requestChallenge('0xabc')).rejects.toMatchObject({ code: 'SR_NO_PROVIDERS' });
  });
});

// ─── Receipt scheduler ─────────────────────────────────────────────────────

describe('SpaceRouterReceiptScheduler', () => {
  it('flushes when claimThreshold is hit', async () => {
    const calls: unknown[][] = [];
    const fakeGw = {
      syncReceipts: vi.fn(async (consumer: Hex, envelopes: unknown[]) => {
        calls.push([consumer, envelopes]);
        return { accepted: ['u1', 'u2'], rejected: [], pendingCount: 0 };
      }),
    } as unknown as SpaceRouterGatewayClient;
    const sched = new SpaceRouterReceiptScheduler({
      consumer: TEST_ADDR as Hex, gatewayClient: fakeGw, claimThreshold: 2,
    });
    sched.enqueue({ receipt: { consumer: TEST_ADDR as Hex, gateway: '0x0' as Hex, requestUuid: '0x1' as Hex, bytesServed: '1', priceWei: '1', expiresAt: '1' }, signature: '0xsig' as Hex });
    sched.enqueue({ receipt: { consumer: TEST_ADDR as Hex, gateway: '0x0' as Hex, requestUuid: '0x2' as Hex, bytesServed: '1', priceWei: '1', expiresAt: '1' }, signature: '0xsig' as Hex });
    // Flushing is fire-and-forget — wait a microtask.
    await new Promise<void>((r) => setImmediate(() => r()));
    expect(fakeGw.syncReceipts).toHaveBeenCalledTimes(1);
    await sched.close();
  });

  it('close() is idempotent', async () => {
    const fakeGw = { syncReceipts: vi.fn(async () => ({ accepted: [], rejected: [], pendingCount: 0 })) } as unknown as SpaceRouterGatewayClient;
    const sched = new SpaceRouterReceiptScheduler({ consumer: TEST_ADDR as Hex, gatewayClient: fakeGw });
    await sched.close();
    await sched.close();
  });
});

// ─── Adapter (smart-fallback heuristic) ────────────────────────────────────

describe('SpaceRouterAdapter.shouldFallback', () => {
  it('returns true for Cloudflare 403/429/503', () => {
    expect(SpaceRouterAdapter.shouldFallback(new Response('', { status: 403, headers: { 'cf-ray': 'abc' } }))).toBe(true);
    expect(SpaceRouterAdapter.shouldFallback(new Response('', { status: 429, headers: { 'cf-ray': 'abc' } }))).toBe(true);
    expect(SpaceRouterAdapter.shouldFallback(new Response('', { status: 503, headers: { 'cf-ray': 'abc' } }))).toBe(true);
    expect(SpaceRouterAdapter.shouldFallback(new Response('', { status: 451 }))).toBe(true);
  });
  it('returns false for plain 403 without CF', () => {
    expect(SpaceRouterAdapter.shouldFallback(new Response('', { status: 403 }))).toBe(false);
    expect(SpaceRouterAdapter.shouldFallback(new Response('', { status: 200 }))).toBe(false);
  });
});

// ─── SpaceRouterClient (peer-dep absence) ──────────────────────────────────

describe('SpaceRouterClient.fetch — peer dep missing', () => {
  it('throws SR_PEER_DEP_MISSING when @spacenetwork/spacerouter is not installed', async () => {
    const signer = new KeypairSpaceRouterSigner(TEST_PK);
    const sr = new SpaceRouterClient({
      chain: CHAINS['creditcoin-testnet']!,
      signer,
      escrowAddress: ESCROW,
      tokenAddress: ESCROW,
      gatewayUrl: 'https://gw',
    });
    await expect(sr.fetch('https://example.com')).rejects.toBeInstanceOf(SpaceRouterPeerDepMissingError);
  });
});

// ─── PolicyEngine bandwidth + region rules ─────────────────────────────────

describe('PolicyEngine — bandwidth rules', () => {
  it('denies when region not in allowedRegions', () => {
    const engine = PolicyEngine.fromConfig({ allowedRegions: ['US'] });
    const decision = engine.evaluate({ url: 'x', amount: 0n, chain: 'creditcoin-testnet', region: 'JP' });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toMatch(/region/i);
  });

  it('denies when daily bandwidth limit reached', () => {
    const engine = PolicyEngine.fromConfig({ bandwidthMaxPerDay: 1024n });
    engine.recordBandwidth(1024n);
    const decision = engine.evaluate({ url: 'x', amount: 0n, chain: 'creditcoin-testnet', bytesServed: 1n });
    expect(decision.allowed).toBe(false);
  });
});

describe('SpendingGuard — bandwidth flow', () => {
  it('records a bandwidth audit entry', () => {
    const guard = new SpendingGuard(new PolicyEngine([]), new AuditLog());
    guard.recordBandwidth({ url: 'https://h.com', amount: 0n, chain: 'creditcoin-testnet', bytesServed: 4096n, region: 'US', ipType: 'residential' });
    const entries = guard.getAudit().query({ type: 'bandwidth' });
    expect(entries).toHaveLength(1);
    expect(entries[0].bytesServed).toBe(4096n);
  });
});

// ─── PaymentClient wiring ──────────────────────────────────────────────────

describe('PaymentClient — SpaceRouter wiring', () => {
  it('soft-skips when peer dep + creditcoin chain present without strict', () => {
    // Should not throw — just register the adapter; first call to fetch via proxy would surface peer-dep error.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createPaymentClient({
      chains: ['creditcoin-testnet'],
      ows: { wallet: 'agent', privateKey: TEST_PK },
      spacerouter: { gatewayUrl: 'https://gw.test', escrowContract: ESCROW, tokenAddress: ESCROW },
    });
    expect(client).toBeDefined();
    warn.mockRestore();
  });

  it('proxy:auto direct success path does not invoke proxy', async () => {
    const client = createPaymentClient({
      chains: ['base-sepolia'],
      ows: { wallet: 'agent', privateKey: TEST_PK },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"ok":true}', { status: 200 }),
    );
    const r = await client.fetchWithPayment('https://example.com', undefined, { proxy: 'auto' });
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
