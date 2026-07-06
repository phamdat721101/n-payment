import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StellarAnchorClient,
  DefaultAnchorRegistry,
  stellarAgentKit,
  type AnchorDescriptor,
  type OffRampQuoteResult,
  type OffRampB2BHandle,
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

  it('2. findAnchor("MGUSD","JPY","JP") returns empty (no anchor supports JPY payout)', async () => {
    // v0.30 note: MoneyGram is now GLOBAL, so we probe an unsupported fiat instead of geography.
    fetchSpy = mockFetch([]);
    const client = new StellarAnchorClient();
    const anchors = await client.findAnchor('MGUSD', 'JPY', 'JP');
    expect(anchors).toEqual([]);
  });

  it('3. findAnchor("USDC","EUR","EU") returns LOBSTR', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_OK, { status: 200 }) : undefined),
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

// ─── v0.30 additions — SEP-38 quote + SEP-31 b2bPayout + stellarAgentKit facade ───────────

const STELLAR_TOML_FULL = `
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
TRANSFER_SERVER="https://api.moneygram.com/sep24"
TRANSFER_SERVER_SEP0024="https://api.moneygram.com/sep24"
DIRECT_PAYMENT_SERVER="https://api.moneygram.com/sep31"
ANCHOR_QUOTE_SERVER="https://api.moneygram.com/sep38"
WEB_AUTH_ENDPOINT="https://api.moneygram.com/sep10"
KYC_SERVER="https://api.moneygram.com/sep12"
`;

describe('v0.30 — SEP-38 quote() + SEP-31 b2bPayout() + stellarAgentKit facade', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    vi.useRealTimers();
  });

  it('T11. quote() happy path — SEP-10 → SEP-38 → returns rate/expiresAt/fee/quoteId', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_FULL, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'CHALLENGE' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'JWT' }), { status: 200 }) : undefined),
      (url) =>
        url.startsWith('https://api.moneygram.com/sep38/price')
          ? new Response(
              JSON.stringify({
                price: '1.00',
                sell_amount: '10.00',
                buy_amount: '9.95',
                expires_at: '2026-07-06T10:00:00Z',
                fee: { total: '0.05', asset: 'iso4217:USD' },
                id: 'quote-abc',
              }),
              { status: 200 },
            )
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    const q: OffRampQuoteResult = await client.quote({
      asset: 'USDC',
      amount: '10.00',
      fiat: 'USD',
      country: 'US',
      signer: stubSigner,
    });
    expect(q.rate).toBe('1.00');
    expect(q.expiresAt).toBe('2026-07-06T10:00:00Z');
    expect(q.quoteId).toBe('quote-abc');
    expect(q.anchor.homeDomain).toBe('moneygram.com');
  });

  it('T12. b2bPayout() happy path — SEP-10 → SEP-31 → returns handle with receiverInfoUrl', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_FULL, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'CHALLENGE' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'JWT' }), { status: 200 }) : undefined),
      (url) =>
        url === 'https://api.moneygram.com/sep31/transactions'
          ? new Response(
              JSON.stringify({
                id: 'b2b-tx-1',
                stellar_account_id: 'GANCHORACCOUNT',
                stellar_memo_type: 'hash',
                stellar_memo: 'AABB',
                receiver_info_url: 'https://api.moneygram.com/sep12/register?receiver=alice',
              }),
              { status: 200 },
            )
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    const handle: OffRampB2BHandle = await client.b2bPayout({
      asset: 'USDC',
      amount: '100.00',
      fiat: 'USD',
      country: 'US',
      signer: stubSigner,
      receiverId: 'alice',
      fields: { first_name: 'Alice', last_name: 'Anchor' },
    });
    expect(handle.transactionId).toBe('b2b-tx-1');
    expect(handle.receiverInfoUrl).toContain('sep12/register');
    expect(handle.anchor.homeDomain).toBe('moneygram.com');
  });

  it('T13. stellarAgentKit(signer).cashOut(...) delegates to StellarAnchorClient.cashOut', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_FULL, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'X' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'T' }), { status: 200 }) : undefined),
      (url) =>
        url.includes('/sep24/transactions/withdraw/interactive')
          ? new Response(JSON.stringify({ id: 'agent-tx', url: 'https://moneygram.com/p' }), { status: 200 })
          : undefined,
    ]);
    const kit = stellarAgentKit(stubSigner);
    const handle = await kit.cashOut('10.00', 'USDC', 'USD');
    expect(handle.transactionId).toBe('agent-tx');
  });

  it('T14. stellarAgentKit(signer).corridors() returns pre-flattened list', async () => {
    fetchSpy = mockFetch([]);
    const kit = stellarAgentKit(stubSigner);
    const corridors = await kit.corridors();
    // At minimum MoneyGram + Vibrant + LOBSTR seeded from DEFAULT_ANCHORS.
    expect(corridors.length).toBeGreaterThanOrEqual(3);
    // Every row has the shape { anchor, from, to, countries }.
    for (const c of corridors) {
      expect(typeof c.anchor).toBe('string');
      expect(typeof c.from).toBe('string');
      expect(typeof c.to).toBe('string');
      expect(Array.isArray(c.countries)).toBe(true);
    }
    // MoneyGram USDC→USD corridor is present.
    expect(corridors.find((c) => c.anchor === 'MoneyGram Access' && c.from === 'USDC' && c.to === 'USD')).toBeDefined();
  });

  it('T15. cashOut with unverified MGUSD does not throw (warn-once semantics)', async () => {
    // v0.30 SF-6 closure: assertVerifiedIssuer warns on unverified issuers but never throws.
    // We verify the behavioural contract (no-throw) rather than warn count, which is
    // process-global state that earlier v0.21 tests may have already consumed.
    const prevOverride = process.env.STELLAR_MGUSD_ISSUER;
    delete process.env.STELLAR_MGUSD_ISSUER;

    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_FULL, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'X' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'T' }), { status: 200 }) : undefined),
      (url) =>
        url.includes('/sep24/transactions/withdraw/interactive')
          ? new Response(JSON.stringify({ id: 'tx-1', url: 'https://x' }), { status: 200 })
          : undefined,
    ]);

    const client = new StellarAnchorClient();
    const handle = await client.cashOut('1.00', 'MGUSD', 'USD', stubSigner);
    expect(handle.transactionId).toBe('tx-1');

    if (prevOverride) process.env.STELLAR_MGUSD_ISSUER = prevOverride;
  });

  it('T16. fetchWithTimeout aborts after configured timeoutMs → OFFRAMP_TIMEOUT', async () => {
    // Pre-populate a synthetic anchor with serviceUrls to skip TOML hydration; the
    // first real network hop (SEP-10 challenge) then races the 50ms timeout deterministically.
    const registry = new DefaultAnchorRegistry([
      {
        homeDomain: 'timeout.example',
        name: 'TimeoutAnchor',
        supportedAssets: ['USDC'],
        supportedFiat: ['USD'],
        supportedCountries: ['GLOBAL'],
        serviceUrls: {
          transferServer: 'https://timeout.example/sep24',
          webAuthEndpoint: 'https://timeout.example/sep10',
        },
      },
    ]);
    fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockImplementation((...args: unknown[]) => {
      const init = args[1] as RequestInit | undefined;
      const signal = init?.signal;
      // Simulate a hung request that never resolves; abort surfaces as AbortError.
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The user aborted a request.');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });

    const client = new StellarAnchorClient(registry);
    await expect(
      client.cashOut('1.00', 'USDC', 'USD', stubSigner, 'US', true, /* timeoutMs */ 50),
    ).rejects.toThrowError(/OFFRAMP_TIMEOUT|Anchor request timed out|did not respond within/);
  });

  it('T17. SEP-38 non-200 surfaces as OFFRAMP_QUOTE_FAILED with hint', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_FULL, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'X' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'T' }), { status: 200 }) : undefined),
      (url) =>
        url.startsWith('https://api.moneygram.com/sep38/price')
          ? new Response('{"error":"corridor closed"}', { status: 400 })
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    await expect(
      client.quote({ asset: 'USDC', amount: '10.00', fiat: 'USD', country: 'US', signer: stubSigner }),
    ).rejects.toThrowError(/OFFRAMP_QUOTE_FAILED|SEP-38 quote failed/);
  });

  it('T18. SEP-31 non-200 surfaces as OFFRAMP_B2B_FAILED with hint', async () => {
    fetchSpy = mockFetch([
      (url) => (url.endsWith('/.well-known/stellar.toml') ? new Response(STELLAR_TOML_FULL, { status: 200 }) : undefined),
      (url) => (url.includes('/sep10?account=') ? new Response(JSON.stringify({ transaction: 'X' }), { status: 200 }) : undefined),
      (url) => (url === 'https://api.moneygram.com/sep10' ? new Response(JSON.stringify({ token: 'T' }), { status: 200 }) : undefined),
      (url) =>
        url === 'https://api.moneygram.com/sep31/transactions'
          ? new Response('{"error":"receiver_id required"}', { status: 400 })
          : undefined,
    ]);
    const client = new StellarAnchorClient();
    await expect(
      client.b2bPayout({ asset: 'USDC', amount: '100.00', fiat: 'USD', country: 'US', signer: stubSigner }),
    ).rejects.toThrowError(/OFFRAMP_B2B_FAILED|SEP-31 direct-payment failed/);
  });

  it.skipIf(!process.env.STELLAR_TESTNET_LIVE)(
    'T19. [live] cashOut round-trip against testanchor.stellar.org (testnet)',
    async () => {
      // Requires env: STELLAR_TESTNET_LIVE=1 STELLAR_TESTNET_ADDRESS=G... STELLAR_TESTNET_SEED=S...
      // The signer must have testnet USDC trustline + XLM base reserve.
      const address = process.env.STELLAR_TESTNET_ADDRESS!;
      const seed = process.env.STELLAR_TESTNET_SEED!;
      if (!address || !seed) return;
      const liveSigner: StellarSigner = {
        address,
        signAuthEntry: async () => {
          throw new Error('signAuthEntry not implemented in live smoke');
        },
        signTransaction: async (xdr) => {
          // Live signer would use @stellar/stellar-sdk here. Kept out to avoid dep bloat.
          throw new Error(`live smoke needs @stellar/stellar-sdk to sign ${xdr.slice(0, 8)}...`);
        },
        signRaw: async (b) => b,
      };
      const registry = new DefaultAnchorRegistry([
        {
          homeDomain: 'testanchor.stellar.org',
          name: 'SDF Test Anchor',
          supportedAssets: ['USDC'],
          supportedFiat: ['USD'],
          supportedCountries: ['GLOBAL'],
          serviceUrls: {},
        },
      ]);
      const kit = stellarAgentKit(liveSigner, { registry, isMainnet: false });
      const handle = await kit.cashOut('10.00', 'USDC', 'USD');
      expect(handle.transactionId).toBeTruthy();
      expect(handle.moreInfoUrl).toMatch(/testanchor\.stellar\.org|stellar\.org/);
    },
    30_000,
  );
});
