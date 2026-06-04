import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  StellarKyaGate,
  StellarKyaCredentialFetcher,
  attachKyaIfRequired,
  canonicalCredentialBytes,
  type KyaCredential,
} from '../src/stellar/kya.js';

interface KeyPair {
  pubkey: string; // G... 56-char
  secret: string; // S... seed
  raw: { sign(msg: Buffer): Uint8Array };
}

async function makeKeypair(): Promise<KeyPair> {
  const sdk = await import('@stellar/stellar-sdk');
  const seed = randomBytes(32);
  const kp = sdk.Keypair.fromRawEd25519Seed(seed);
  return {
    pubkey: kp.publicKey(),
    secret: kp.secret(),
    raw: kp,
  };
}

function signCredential(cred: Omit<KyaCredential, 'signature'>, signer: { sign(msg: Buffer): Uint8Array }): KyaCredential {
  const fullForBytes: KyaCredential = { ...cred, signature: '' };
  const bytes = canonicalCredentialBytes(fullForBytes);
  const sig = signer.sign(Buffer.from(bytes));
  return { ...cred, signature: Buffer.from(sig).toString('base64') };
}

function freshCred(agent: string, tier: number, ageMs = 0, validForMs = 60_000): Omit<KyaCredential, 'signature'> {
  const now = Date.now() - ageMs;
  return {
    agentAddress: agent,
    reputationScore: 80,
    kyaTier: tier,
    issuedAt: new Date(now).toISOString(),
    validUntil: new Date(now + validForMs).toISOString(),
    issuer: 'erc8004:base:0xabc',
  };
}

/**
 * Minimal Express-shaped req/res for middleware testing — avoids pulling express into the test file.
 */
function makeReq(header?: string) {
  return {
    header: (name: string) => (name === 'x-kya-credential' ? header : undefined),
  } as unknown as Parameters<ReturnType<StellarKyaGate['middleware']>>[0];
}
function makeRes() {
  const captured: { code?: number; body?: unknown } = {};
  const res = {
    status(c: number) {
      captured.code = c;
      return this;
    },
    json(b: unknown) {
      captured.body = b;
      return this;
    },
  } as unknown as Parameters<ReturnType<StellarKyaGate['middleware']>>[1];
  return { res, captured };
}

describe('StellarKyaGate (v0.21)', () => {
  const ORIGINAL_ENV = { ...process.env };
  let keys: KeyPair;

  beforeEach(async () => {
    keys = await makeKeypair();
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('1. missing header → 402 with kya_required:true and min_kya_tier', async () => {
    const gate = new StellarKyaGate({ minKyaTier: 2, trustedIssuerPubkey: keys.pubkey });
    const { res, captured } = makeRes();
    let nextCalled = false;
    await gate.middleware()(makeReq(), res, () => { nextCalled = true; });
    expect(captured.code).toBe(402);
    expect((captured.body as { kya_required: boolean }).kya_required).toBe(true);
    expect((captured.body as { min_kya_tier: number }).min_kya_tier).toBe(2);
    expect(nextCalled).toBe(false);
  });

  it('2. tier below required → 403', async () => {
    const gate = new StellarKyaGate({ minKyaTier: 3, trustedIssuerPubkey: keys.pubkey });
    const cred = signCredential(freshCred('GAGENT', 2), keys.raw);
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const { res, captured } = makeRes();
    await gate.middleware()(makeReq(header), res, () => undefined);
    expect(captured.code).toBe(403);
  });

  it('3. expired credential → 403', async () => {
    const gate = new StellarKyaGate({ minKyaTier: 1, trustedIssuerPubkey: keys.pubkey });
    const cred = signCredential(freshCred('GAGENT', 2, 0, -1), keys.raw); // validUntil in the past
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const { res, captured } = makeRes();
    await gate.middleware()(makeReq(header), res, () => undefined);
    expect(captured.code).toBe(403);
    expect((captured.body as { error: string }).error).toMatch(/expired/);
  });

  it('4. aged credential beyond maxAgeMs → 403', async () => {
    const gate = new StellarKyaGate({ minKyaTier: 1, trustedIssuerPubkey: keys.pubkey, maxAgeMs: 100 });
    const cred = signCredential(freshCred('GAGENT', 2, 1000, 60_000), keys.raw); // 1s old, maxAge 100ms
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const { res, captured } = makeRes();
    await gate.middleware()(makeReq(header), res, () => undefined);
    expect(captured.code).toBe(403);
    expect((captured.body as { error: string }).error).toMatch(/too old/);
  });

  it('5. invalid signature → 403', async () => {
    const gate = new StellarKyaGate({ minKyaTier: 1, trustedIssuerPubkey: keys.pubkey });
    const otherKeys = await makeKeypair();
    const cred = signCredential(freshCred('GAGENT', 2), otherKeys.raw); // signed by wrong key
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const { res, captured } = makeRes();
    await gate.middleware()(makeReq(header), res, () => undefined);
    expect(captured.code).toBe(403);
    expect((captured.body as { error: string }).error).toMatch(/invalid signature/);
  });

  it('6. valid credential → next() called and req.kya populated', async () => {
    const gate = new StellarKyaGate({ minKyaTier: 1, trustedIssuerPubkey: keys.pubkey });
    const cred = signCredential(freshCred('GAGENT', 2), keys.raw);
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const req = makeReq(header) as unknown as Record<string, unknown>;
    const { res, captured } = makeRes();
    let nextCalled = false;
    await gate.middleware()(req as never, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(captured.code).toBeUndefined();
    expect((req.kya as KyaCredential).agentAddress).toBe('GAGENT');
  });

  it('7. custom maxAgeMs honored — long maxAge accepts old credential', async () => {
    const gate = new StellarKyaGate({
      minKyaTier: 1,
      trustedIssuerPubkey: keys.pubkey,
      maxAgeMs: 60_000_000, // very generous
    });
    const cred = signCredential(freshCred('GAGENT', 2, 60_000, 600_000), keys.raw); // 1 min old, valid 10 min
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const { res, captured } = makeRes();
    let nextCalled = false;
    await gate.middleware()(makeReq(header), res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(captured.code).toBeUndefined();
  });

  it('8. missing trustedIssuerPubkey config + missing env → throws KYA_NO_ISSUER', async () => {
    delete process.env.STELLAR_KYA_ORACLE_PUBKEY;
    const gate = new StellarKyaGate({ minKyaTier: 1 });
    const cred = signCredential(freshCred('GAGENT', 2), keys.raw);
    await expect(gate.verify(cred)).rejects.toThrowError(/KYA_NO_ISSUER|trustedIssuerPubkey/);
  });

  it('9. encodeHeader/decodeHeader round-trip preserves credential', () => {
    const cred = signCredential(freshCred('GAGENT', 2), keys.raw);
    const header = StellarKyaCredentialFetcher.encodeHeader(cred);
    const decoded = StellarKyaCredentialFetcher.decodeHeader(header);
    expect(decoded).toEqual(cred);
  });
});

describe('attachKyaIfRequired (adapter pass-through helper)', () => {
  it('no-op when challenge omits kya_required', async () => {
    const headers = new Headers();
    await attachKyaIfRequired(headers, undefined, undefined, 'GAGENT');
    await attachKyaIfRequired(headers, { kya_required: false }, undefined, 'GAGENT');
    expect(headers.get('x-kya-credential')).toBeNull();
  });

  it('throws KYA_NOT_CONFIGURED when required but no fetcher', async () => {
    const headers = new Headers();
    await expect(
      attachKyaIfRequired(headers, { kya_required: true }, undefined, 'GAGENT'),
    ).rejects.toThrowError(/KYA_NOT_CONFIGURED|kyaFetcher/);
  });
});
