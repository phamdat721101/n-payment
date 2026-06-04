import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StellarAnchorClient,
  DefaultAnchorRegistry,
  type AnchorDescriptor,
} from '../src/offramp/stellar-anchor.js';
import type { StellarSigner } from '../src/stellar/signer.js';

const stubSigner: StellarSigner = {
  address: 'GBUYER' + 'A'.repeat(50),
  signAuthEntry: async () => 'stub',
  signTransaction: async (xdr) => `signed:${xdr}`,
  signRaw: async (b) => b,
};

const STELLAR_TOML_OK = `
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
TRANSFER_SERVER="https://api.moneygram.com/sep24"
WEB_AUTH_ENDPOINT="https://api.moneygram.com/sep10"
KYC_SERVER="https://api.moneygram.com/sep12"
`;

const STELLAR_TOML_INCOMPLETE = `
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
`;

/** Mock-fetch helper: returns the next pre-queued response per URL pattern. */
function mockFetch(handlers: Array<(url: string) => Promise<Response> | Response | undefined>) {
  return vi.spyOn(globalThis, 'fetch' as never).mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    for (const h of handlers) {
      const r = await h(url);
      if (r) return r;
    }
    return new Response('not mocked', { status: 500 });
  });
}

describe('StellarAnchorClient (SEP-10 / SEP-24)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('1. findAnchor("MGUSD","USD","US") includes MoneyGram from default registry', async () => {
    fetchSpy = mockFetch([
      (url) => (url.includes('moneygram.com') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
    ]);
    const client = new StellarAnchorClient();
    const anchors = await client.findAnchor('MGUSD', 'USD', 'US');
    expect(anchors.find((a) => a.homeDomain === 'moneygram.com')).toBeDefined();
  });

  it('2. findAnchor("MGUSD","USD","JP") returns empty (MoneyGram not in JP)', async () => {
    fetchSpy = mockFetch([]);
    const client = new StellarAnchorClient();
    const anchors = await client.findAnchor('MGUSD', 'USD', 'JP');
    expect(anchors).toEqual([]);
  });

  it('3. findAnchor("USDC","EUR","EU") returns LOBSTR', async () => {
    fetchSpy = mockFetch([
      (url) => (url.includes('lobstr.co') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
    ]);
    const client = new StellarAnchorClient();
    const anchors = await client.findAnchor('USDC', 'EUR', 'EU');
    expect(anchors.find((a) => a.homeDomain === 'lobstr.co')).toBeDefined();
  });

  it('4. custom registry: add() then findAnchor() returns the custom anchor', async () => {
    const registry = new DefaultAnchorRegistry([]);
    const custom: AnchorDescriptor = {
      homeDomain: 'custom.example',
      name: 'CustomAnchor',
      supportedAssets: ['MGUSD'],
      supportedFiat: ['USD'],
      supportedCountries: ['GLOBAL'],
      serviceUrls: {
        transferServer: 'https://custom.example/sep24',
        webAuthEndpoint: 'https://custom.example/sep10',
      },
    };
    registry.add(custom);
    const client = new StellarAnchorClient(registry);
    const anchors = await client.findAnchor('MGUSD', 'USD', 'XX');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].name).toBe('CustomAnchor');
  });

  it('5. stellar.toml hydration parses TRANSFER_SERVER + WEB_AUTH_ENDPOINT + KYC_SERVER', async () => {
    fetchSpy = mockFetch([(url) => (url.includes('lobstr.co') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined)]);
    const registry = new DefaultAnchorRegistry();
    const lobstr = await registry.byDomain('lobstr.co');
    expect(lobstr?.serviceUrls.transferServer).toBe('https://api.moneygram.com/sep24');
    expect(lobstr?.serviceUrls.webAuthEndpoint).toBe('https://api.moneygram.com/sep10');
    expect(lobstr?.serviceUrls.kycServer).toBe('https://api.moneygram.com/sep12');
  });

  it('6. initiate() throws ANCHOR_TOML_INCOMPLETE when stellar.toml missing required fields', async () => {
    fetchSpy = mockFetch([
      (url) => (url.includes('vibrantapp.com') ? new Response(STELLAR_TOML_INCOMPLETE, { status: 200 }) : undefined),
    ]);
    const client = new StellarAnchorClient();
    await expect(
      client.initiate({
        asset: 'USDC',
        amount: '10.00',
        fiat: 'USD',
        country: 'US',
        signer: stubSigner,
        preferAnchor: 'vibrantapp.com',
      }),
    ).rejects.toThrowError(/ANCHOR_TOML_INCOMPLETE|stellar\.toml missing/);
  });

  it('7. SEP-10 JWT auth round-trips (challenge → sign → token)', async () => {
    fetchSpy = mockFetch([
      // stellar.toml
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
      // SEP-10 challenge (GET)
      (url) =>
        url.startsWith('https://api.moneygram.com/sep10?account=')
          ? new Response(JSON.stringify({ transaction: 'CHALLENGE_XDR' }), { status: 200 })
          : undefined,
      // SEP-10 token (POST)
      (url) =>
        url === 'https://api.moneygram.com/sep10'
          ? new Response(JSON.stringify({ token: 'JWT_TOKEN' }), { status: 200 })
          : undefined,
      // SEP-24 withdraw initiate (POST)
      (url) =>
        url.startsWith('https://api.moneygram.com/sep24/transactions/withdraw/interactive')
          ? new Response(JSON.stringify({ id: 'tx-123', url: 'https://moneygram.com/payout/tx-123' }), { status: 200 })
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    const handle = await client.initiate({
      asset: 'MGUSD',
      amount: '10.00',
      fiat: 'USD',
      country: 'US',
      signer: stubSigner,
    });
    expect(handle.transactionId).toBe('tx-123');
    expect(handle.moreInfoUrl).toBe('https://moneygram.com/payout/tx-123');
  });

  it('8. cashOut convenience defaults country=US', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'X' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'T' }), { status: 200 }) : undefined),
      (url) =>
        url.includes('/sep24/transactions/withdraw/interactive')
          ? new Response(JSON.stringify({ id: 'tx-456', url: 'https://moneygram.com/p' }), { status: 200 })
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    const handle = await client.cashOut('25.00', 'MGUSD', 'USD', stubSigner);
    expect(handle.transactionId).toBe('tx-456');
  });

  it('9. status() poll returns transaction status', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'X' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'T' }), { status: 200 }) : undefined),
      (url) =>
        url.includes('/sep24/transactions/withdraw/interactive')
          ? new Response(JSON.stringify({ id: 'tx-789', url: 'https://x' }), { status: 200 })
          : undefined,
      (url) =>
        url.includes('/sep24/transaction?id=')
          ? new Response(
              JSON.stringify({
                transaction: { status: 'pending_user_transfer_start', updated_at: '2026-06-04T20:00:00Z' },
              }),
              { status: 200 },
            )
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    const handle = await client.cashOut('5.00', 'MGUSD', 'USD', stubSigner);
    const s = await handle.status();
    expect(s.status).toBe('pending_user_transfer_start');
    expect(s.updatedAt).toBe('2026-06-04T20:00:00Z');
  });

  it('10. SEP-10 auth failure surfaces as ANCHOR_AUTH_FAILED', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response('forbidden', { status: 403 }) : undefined),
    ]);
    const client = new StellarAnchorClient();
    await expect(
      client.initiate({
        asset: 'MGUSD',
        amount: '1.00',
        fiat: 'USD',
        country: 'US',
        signer: stubSigner,
      }),
    ).rejects.toThrowError(/ANCHOR_AUTH_FAILED|SEP-10 challenge fetch failed/);
  });
});
