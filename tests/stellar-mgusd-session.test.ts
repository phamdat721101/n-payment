import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { StellarSessionClient, StellarSessionServer } from '../src/stellar/session.js';
import type { StellarSessionClientConfig, StellarSessionServerConfig } from '../src/stellar/session.js';
import type { StellarSigner } from '../src/stellar/signer.js';
import { parseStellarAsset } from '../src/stellar/assets.js';

// Reusable mock channel id (Stellar contract addresses are 56 chars starting with C).
const CHANNEL = 'C' + 'A'.repeat(55);

// Stub closeSigner — server's closeChannel path is not exercised here (no Soroban RPC available).
// All tests are off-chain sign-and-verify only.
const stubCloseSigner: StellarSigner = {
  address: 'G' + 'A'.repeat(55),
  signAuthEntry: async () => 'stub',
  signTransaction: async (xdr) => xdr,
  signRaw: async (b) => b,
};

interface KeyPair {
  secretHex: string;
  pubkeyHex: string;
}

/**
 * Minimal ed25519 keypair generator using @stellar/stellar-sdk so the same
 * signature/verify path used in production runs in the test.
 */
async function generateKeypair(): Promise<KeyPair> {
  const sdk = await import('@stellar/stellar-sdk');
  const seed = randomBytes(32);
  const keypair = sdk.Keypair.fromRawEd25519Seed(seed);
  // Stellar pubkey raw bytes = base32 decode of the G... address.
  const pubkeyRaw = sdk.StrKey.decodeEd25519PublicKey(keypair.publicKey());
  return {
    secretHex: Buffer.from(seed).toString('hex'),
    pubkeyHex: Buffer.from(pubkeyRaw).toString('hex'),
  };
}

function makeClient(asset: StellarSessionClientConfig['asset'], keys: KeyPair): StellarSessionClient {
  return new StellarSessionClient({
    channel: CHANNEL,
    commitmentSecretHex: keys.secretHex,
    chainKey: 'stellar-testnet',
    asset,
  });
}

function makeServer(asset: StellarSessionServerConfig['asset'], keys: KeyPair): StellarSessionServer {
  return new StellarSessionServer({
    channel: CHANNEL,
    commitmentPubkeyHex: keys.pubkeyHex,
    chainKey: 'stellar-testnet',
    closeSigner: stubCloseSigner,
    asset,
  });
}

describe('Stellar Session — asset-aware preimage (v0.21)', () => {
  let keys: KeyPair;
  beforeEach(async () => {
    keys = await generateKeypair();
  });

  it('1. v0.20 fallback (asset undefined on both sides) round-trips successfully', async () => {
    const client = makeClient(undefined, keys);
    const server = makeServer(undefined, keys);
    const v = await client.signCommitment(1_000_000n);
    const verdict = await server.verifyVoucher(v.credential, 1_000_000n);
    expect(verdict.valid).toBe(true);
  });

  it('2. asset:MGUSD and asset:USDC produce different preimages (sigs not interchangeable)', async () => {
    const clientMgusd = makeClient('MGUSD', keys);
    const clientUsdc = makeClient('USDC', keys);
    const vMgusd = await clientMgusd.signCommitment(1_000_000n);
    const vUsdc = await clientUsdc.signCommitment(1_000_000n);
    expect(vMgusd.credential).not.toBe(vUsdc.credential);
  });

  it('3. matching asset:MGUSD on client+server round-trips successfully', async () => {
    const client = makeClient('MGUSD', keys);
    const server = makeServer('MGUSD', keys);
    const v = await client.signCommitment(parseStellarAsset('0.001', 'MGUSD'));
    const verdict = await server.verifyVoucher(v.credential, parseStellarAsset('0.001', 'MGUSD'));
    expect(verdict.valid).toBe(true);
  });

  it('4. mismatched asset (client:MGUSD vs server:USDC) → invalid signature on every voucher', async () => {
    const client = makeClient('MGUSD', keys);
    const server = makeServer('USDC', keys);
    // The FIRST voucher fails sig (delta-check passes because highestCumulative=0).
    const v1 = await client.signCommitment(1_000_000n);
    const verdict1 = await server.verifyVoucher(v1.credential, 1_000_000n);
    expect(verdict1.valid).toBe(false);
    if (!verdict1.valid) expect(verdict1.reason).toBe('invalid signature');
    // Every subsequent voucher also fails — server's highestCumulative never advances on bad sig,
    // so further commitments either fail the delta check or the sig check, but never validate.
    for (let i = 0; i < 4; i++) {
      const v = await client.signCommitment(1_000_000n);
      const verdict = await server.verifyVoucher(v.credential, 1_000_000n);
      expect(verdict.valid).toBe(false);
    }
  });

  it('5. replay protection still works when assets match', async () => {
    const client = makeClient('MGUSD', keys);
    const server = makeServer('MGUSD', keys);
    const v1 = await client.signCommitment(1_000n);
    const v1Result = await server.verifyVoucher(v1.credential, 1_000n);
    expect(v1Result.valid).toBe(true);
    // replay v1 → should reject (cumulative not increased)
    const replay = await server.verifyVoucher(v1.credential, 0n);
    expect(replay.valid).toBe(false);
  });

  it('6. unknown asset symbol surfaces parseStellarAsset error', () => {
    expect(() => parseStellarAsset('1.0', 'XYZ')).toThrowError(/STELLAR_ASSET_UNKNOWN|Unknown Stellar asset/);
  });

  it('7. integration: 100 vouchers in MGUSD round-trip successfully', async () => {
    const client = makeClient('MGUSD', keys);
    const server = makeServer('MGUSD', keys);
    const perCall = parseStellarAsset('0.001', 'MGUSD');
    let lastValid = 0;
    for (let i = 0; i < 100; i++) {
      const v = await client.signCommitment(perCall);
      const verdict = await server.verifyVoucher(v.credential, perCall);
      if (verdict.valid) lastValid = i + 1;
    }
    expect(lastValid).toBe(100);
    expect(server.getHighestCumulative()).toBe(perCall * 100n);
  });

  it('8. fallback (undefined asset) and explicit USDC produce DIFFERENT preimages', async () => {
    // This protects against accidental drift between v0.20 callers and v0.21 explicit-USDC callers.
    const clientFallback = makeClient(undefined, keys);
    const clientExplicit = makeClient('USDC', keys);
    const v1 = await clientFallback.signCommitment(1_000n);
    const v2 = await clientExplicit.signCommitment(1_000n);
    expect(v1.credential).not.toBe(v2.credential);
  });
});
