import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeypairStellarSigner, FreighterStellarSigner } from '../src/stellar/signer.js';
import { StellarChannelsClient } from '../src/stellar/channels-client.js';
import { StellarSessionClient, StellarSessionServer } from '../src/stellar/session.js';
import { StellarX402Adapter } from '../src/adapters/stellar-x402.js';
import { StellarMppAdapter } from '../src/adapters/stellar-mpp.js';
import { createPaymentClient } from '../src/client.js';

// Test-only ed25519 32-byte seed in hex
const TEST_COMMITMENT_SECRET = '1'.padEnd(64, '0');
const TEST_CHANNEL_ID = 'CTESTCHANNELCONTRACTID00000000000000000000000000000000000000';

// ─── FreighterStellarSigner — browser-only, throws cleanly in Node ──────────

describe('FreighterStellarSigner', () => {
  it('throws FREIGHTER_NOT_AVAILABLE in Node test environment', async () => {
    const signer = new FreighterStellarSigner();
    await expect(signer.signAuthEntry('aGVsbG8=', 'Test SDF Network ; September 2015')).rejects.toMatchObject({
      code: 'FREIGHTER_NOT_AVAILABLE',
    });
  });

  it('signRaw throws clear hint about commitment keys', async () => {
    const signer = new FreighterStellarSigner();
    await expect(signer.signRaw(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'FREIGHTER_NO_RAW_SIGN',
    });
  });
});

describe('KeypairStellarSigner', () => {
  it('rejects empty secret', () => {
    expect(() => new KeypairStellarSigner('')).toThrow(/STELLAR_NO_SECRET|required/);
  });
});

// ─── StellarChannelsClient — facilitator dispatch + auth + error mapping ────

describe('StellarChannelsClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ kinds: [], extensions: [] }), { status: 200 }),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it('defaults to Coinbase facilitator when no apiKey (credential-less)', async () => {
    const client = new StellarChannelsClient();
    await client.getSupported();
    expect(fetchSpy.mock.calls[0][0]).toContain('x402.org/facilitator');
  });

  it('switches to OZ Channels testnet when apiKey provided', async () => {
    const client = new StellarChannelsClient({ apiKey: 'oz_test_key', isMainnet: false });
    await client.getSupported();
    expect(fetchSpy.mock.calls[0][0]).toContain('channels.openzeppelin.com/x402/testnet');
  });

  it('switches to OZ Channels mainnet when apiKey + isMainnet', async () => {
    const client = new StellarChannelsClient({ apiKey: 'oz_main_key', isMainnet: true });
    await client.getSupported();
    expect(fetchSpy.mock.calls[0][0]).toBe('https://channels.openzeppelin.com/x402/supported');
  });

  it('attaches Bearer auth on /verify when apiKey present', async () => {
    const client = new StellarChannelsClient({ apiKey: 'oz_key' });
    await client.verify({}, {});
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer oz_key');
  });

  it('maps 401 to STELLAR_CHANNELS_AUTH_FAILED', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ invalidReason: 'bad apiKey' }), { status: 401 }));
    const client = new StellarChannelsClient({ apiKey: 'wrong' });
    await expect(client.verify({}, {})).rejects.toMatchObject({ code: 'STELLAR_CHANNELS_AUTH_FAILED' });
  });

  it('maps 429 to STELLAR_CHANNELS_RATE_LIMITED', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ errorReason: 'rate limit' }), { status: 429 }));
    const client = new StellarChannelsClient({ apiKey: 'k' });
    await expect(client.settle({}, {})).rejects.toMatchObject({ code: 'STELLAR_CHANNELS_RATE_LIMITED' });
  });
});

// ─── Adapter detection (no live network) ────────────────────────────────────

function makeStellar402(network = 'stellar:testnet'): Response {
  const challenge = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepts: [{ scheme: 'exact', network, asset: 'CUSDC...', maxAmountRequired: '10000', payTo: 'GMERCHANT...' }],
  })).toString('base64');
  return new Response(null, { status: 402, headers: { 'payment-required': challenge } });
}

function makeMockSigner(address = 'GTEST') {
  return {
    address,
    signAuthEntry: vi.fn().mockResolvedValue('sig=='),
    signTransaction: vi.fn().mockResolvedValue('signedXdr=='),
    signRaw: vi.fn().mockResolvedValue(new Uint8Array(64)),
  };
}

describe('StellarX402Adapter — detection', () => {
  it('detects stellar:testnet', () => {
    const adapter = new StellarX402Adapter(makeMockSigner(), 'stellar-testnet');
    expect(adapter.detect(makeStellar402('stellar:testnet'))).toBe(true);
  });

  it('detects stellar:pubnet', () => {
    const adapter = new StellarX402Adapter(makeMockSigner(), 'stellar-mainnet');
    expect(adapter.detect(makeStellar402('stellar:pubnet'))).toBe(true);
  });

  it('rejects non-Stellar networks', () => {
    const adapter = new StellarX402Adapter(makeMockSigner(), 'stellar-testnet');
    expect(adapter.detect(makeStellar402('eip155:8453'))).toBe(false);
  });

  it('returns false on missing payment-required header', () => {
    const adapter = new StellarX402Adapter(makeMockSigner(), 'stellar-testnet');
    expect(adapter.detect(new Response(null, { status: 402 }))).toBe(false);
  });
});

describe('StellarMppAdapter — detection', () => {
  it('detects www-authenticate Payment + stellar', () => {
    const adapter = new StellarMppAdapter(makeMockSigner(), 'stellar-testnet');
    const res = new Response(null, { status: 402, headers: {
      'www-authenticate': 'Payment realm="api", method="stellar", amount="0.01"',
    }});
    expect(adapter.detect(res)).toBe(true);
  });

  it('rejects Payment without stellar identifier', () => {
    const adapter = new StellarMppAdapter(makeMockSigner(), 'stellar-testnet');
    const res = new Response(null, { status: 402, headers: {
      'www-authenticate': 'Payment realm="api", method="tempo", amount="0.01"',
    }});
    expect(adapter.detect(res)).toBe(false);
  });
});

// ─── StellarSessionClient + Server (the killer feature) ─────────────────────

describe('StellarSessionClient', () => {
  it('signCommitment increments cumulative monotonically', async () => {
    const client = new StellarSessionClient({
      channel: TEST_CHANNEL_ID,
      commitmentSecretHex: TEST_COMMITMENT_SECRET,
      chainKey: 'stellar-testnet',
    });
    const v1 = await client.signCommitment(100n);
    const v2 = await client.signCommitment(50n);
    expect(v1.cumulativeAmount).toBe(100n);
    expect(v2.cumulativeAmount).toBe(150n);
    expect(client.getCumulative()).toBe(150n);
  });

  it('rejects non-positive amount', async () => {
    const client = new StellarSessionClient({
      channel: TEST_CHANNEL_ID,
      commitmentSecretHex: TEST_COMMITMENT_SECRET,
      chainKey: 'stellar-testnet',
    });
    await expect(client.signCommitment(0n)).rejects.toMatchObject({ code: 'STELLAR_SESSION_INVALID_AMOUNT' });
    await expect(client.signCommitment(-1n)).rejects.toMatchObject({ code: 'STELLAR_SESSION_INVALID_AMOUNT' });
  });

  it('rejects bad commitmentSecretHex length', () => {
    expect(() => new StellarSessionClient({
      channel: TEST_CHANNEL_ID, commitmentSecretHex: 'short', chainKey: 'stellar-testnet',
    })).toThrow(/64-char hex/);
  });

  it('resetCumulative zeros the running total', async () => {
    const client = new StellarSessionClient({
      channel: TEST_CHANNEL_ID,
      commitmentSecretHex: TEST_COMMITMENT_SECRET,
      chainKey: 'stellar-testnet',
    });
    await client.signCommitment(100n);
    client.resetCumulative();
    expect(client.getCumulative()).toBe(0n);
  });

  it('produces a credential parsable as base64 JSON', async () => {
    const client = new StellarSessionClient({
      channel: TEST_CHANNEL_ID,
      commitmentSecretHex: TEST_COMMITMENT_SECRET,
      chainKey: 'stellar-testnet',
    });
    const { credential } = await client.signCommitment(42n);
    const parsed = JSON.parse(Buffer.from(credential, 'base64').toString());
    expect(parsed.channel).toBe(TEST_CHANNEL_ID);
    expect(parsed.cumulativeAmount).toBe('42');
    expect(typeof parsed.signature).toBe('string');
  });
});

describe('StellarSessionServer — replay protection + close guards', () => {
  let client: StellarSessionClient;
  let server: StellarSessionServer;

  beforeEach(async () => {
    client = new StellarSessionClient({
      channel: TEST_CHANNEL_ID,
      commitmentSecretHex: TEST_COMMITMENT_SECRET,
      chainKey: 'stellar-testnet',
    });
    server = new StellarSessionServer({
      channel: TEST_CHANNEL_ID,
      commitmentPubkeyHex: await deriveCommitmentPubkeyHex(TEST_COMMITMENT_SECRET),
      chainKey: 'stellar-testnet',
      closeSigner: makeMockSigner('GSERVER') as any,
    });
  });

  it('accepts first valid voucher', async () => {
    const v = await client.signCommitment(100n);
    const result = await server.verifyVoucher(v.credential, 100n);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.cumulativeAmount).toBe(100n);
    expect(server.getHighestCumulative()).toBe(100n);
  });

  it('rejects replay of same cumulative voucher', async () => {
    const v = await client.signCommitment(100n);
    await server.verifyVoucher(v.credential, 100n);
    const replay = await server.verifyVoucher(v.credential, 100n);
    expect(replay.valid).toBe(false);
    if (!replay.valid) expect(replay.reason).toMatch(/highestSeen|≤/);
  });

  it('rejects mismatched delta', async () => {
    const v = await client.signCommitment(100n);
    const result = await server.verifyVoucher(v.credential, 50n);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/delta|declared/);
  });

  it('rejects mismatched channel id', async () => {
    const v = await client.signCommitment(100n);
    const otherServer = new StellarSessionServer({
      channel: 'COTHERCHANNEL000000000000000000000000000000000000000000000000',
      commitmentPubkeyHex: await deriveCommitmentPubkeyHex(TEST_COMMITMENT_SECRET),
      chainKey: 'stellar-testnet',
      closeSigner: makeMockSigner('GSERVER') as any,
    });
    const result = await otherServer.verifyVoucher(v.credential, 100n);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('channel mismatch');
  });

  it('rejects malformed credential', async () => {
    const result = await server.verifyVoucher('not-base64-json', 100n);
    expect(result.valid).toBe(false);
  });

  it('closeChannel throws when no commitments seen', async () => {
    await expect(server.closeChannel()).rejects.toMatchObject({ code: 'STELLAR_SESSION_NO_COMMITMENT' });
  });
});

// ─── createPaymentClient — soft credential-less + strict + factory ──────────

describe('createPaymentClient — Stellar v0.10', () => {
  const validOws = { wallet: 'test', privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' };

  it('warns and skips Stellar adapters when secretKey missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createPaymentClient({ chains: ['stellar-testnet'], ows: validOws });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stellar chain configured without stellar.secretKey'));
    warn.mockRestore();
  });

  it('throws in strict mode when secretKey missing', () => {
    expect(() => createPaymentClient({
      chains: ['stellar-testnet'], ows: validOws, stellar: { strict: true },
    })).toThrow(/STELLAR_NO_SECRET|strict/);
  });

  it('exposes createStellarSession factory', () => {
    const client = createPaymentClient({ chains: ['stellar-testnet'], ows: validOws });
    const session = client.createStellarSession({
      channel: TEST_CHANNEL_ID,
      commitmentSecretHex: TEST_COMMITMENT_SECRET,
      chainKey: 'stellar-testnet',
    });
    expect(session).toBeInstanceOf(StellarSessionClient);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

async function deriveCommitmentPubkeyHex(secretHex: string): Promise<string> {
  const sdk = await import('@stellar/stellar-sdk');
  const kp = sdk.Keypair.fromRawEd25519Seed(Buffer.from(secretHex, 'hex'));
  return Buffer.from(kp.rawPublicKey()).toString('hex');
}
