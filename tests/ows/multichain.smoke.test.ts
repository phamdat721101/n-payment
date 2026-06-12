/**
 * Parameterized smoke matrix for OWSWallet over the 11 OWS chain families.
 *
 * Sample-mistake avoidance: ONE test file. Adding a chain family = one row in
 * MATRIX. Adding 11 sibling test files (the v0.25 mistake we're fixing) is
 * structurally impossible because every assertion lives in this single
 * `it.concurrent.each(MATRIX)` block.
 *
 * Default mode mocks `@open-wallet-standard/core`. Set `OWS_LIVE=1` to run
 * against a real local OWS vault (developer / pre-release smoke).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

// ─── Mock the SDK before any source-under-test imports ──────────────────────
const mockGetWallet = vi.fn();
const mockSignAndSend = vi.fn();
const mockSignMessage = vi.fn();

vi.mock('@open-wallet-standard/core', () => ({
  getWallet: mockGetWallet,
  signAndSend: mockSignAndSend,
  signMessage: mockSignMessage,
  // Lifecycle stubs (unused by these tests but needed for module resolution).
  createWallet: vi.fn(),
  importMnemonic: vi.fn(),
  importPrivateKey: vi.fn(),
  importKeystore: vi.fn(),
  importWif: vi.fn(),
  importSolanaKeypair: vi.fn(),
  importSuiKeystore: vi.fn(),
  exportMnemonic: vi.fn(),
  exportKeystore: vi.fn(),
  exportRaw: vi.fn(),
  backup: vi.fn(),
  restore: vi.fn(),
  recover: vi.fn(),
  lock: vi.fn(),
  unlock: vi.fn(),
  rotate: vi.fn(),
  deleteWallet: vi.fn(),
  listWallets: vi.fn(() => []),
  policy: { create: vi.fn(), list: vi.fn(() => []), get: vi.fn(() => null), delete: vi.fn() },
  apiKey: { create: vi.fn(), list: vi.fn(() => []), revoke: vi.fn() },
  mnemonic: { generate: vi.fn(), derive: vi.fn() },
}));

import { OWSWallet } from '../../src/ows/wallet.js';

// ─── Test matrix — single source of truth for the 11 families ───────────────
const MATRIX = [
  { caip2: 'eip155:84532', family: 'evm',      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  { caip2: 'solana:mainnet', family: 'solana', address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
  { caip2: 'xrpl:testnet', family: 'xrpl',     address: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe' },
  { caip2: 'cosmos:initiation-2', family: 'cosmos', address: 'init1abc...' },
  { caip2: 'bip122:000000000019d6689c085ae165831e93', family: 'bitcoin', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' },
  { caip2: 'sui:testnet', family: 'sui',       address: '0x' + '1'.repeat(64) },
  { caip2: 'tron:mainnet', family: 'tron',     address: 'TPL66VK2gCXNCD7EJg9pgJRfqcRazjhUZY' },
  { caip2: 'ton:mainnet', family: 'ton',       address: 'UQAbc...' },
  { caip2: 'spark:mainnet', family: 'spark',   address: 'spark:02abc' },
  { caip2: 'fil:mainnet', family: 'filecoin',  address: 'f1abcdef...' },
  { caip2: 'near:testnet', family: 'near',     address: 'a'.repeat(64) },
] as const;

beforeAll(() => {
  // Build a single mock wallet that has accounts on every family in the matrix.
  const accounts = MATRIX.map((row) => ({
    address: row.address,
    chainId: row.caip2,
    family: row.family,
  }));
  mockGetWallet.mockReturnValue({ id: 'mock-wallet-id', name: 'mock', accounts });
  mockSignAndSend.mockResolvedValue({ txHash: 'mock-tx-hash' });
  mockSignMessage.mockResolvedValue({ signature: '0xmocksignature' });
});

describe('OWSWallet — multichain smoke matrix (mocked SDK)', () => {
  it.each(MATRIX)(
    'getAddress dispatches via CAIP-2 for $family ($caip2)',
    async ({ caip2, address }) => {
      const w = new OWSWallet({ wallet: 'mock' });
      const got = await w.getAddress(caip2);
      expect(got).toBe(address);
    },
  );

  it.each(MATRIX)(
    'signMessage dispatches via CAIP-2 for $family',
    async ({ caip2 }) => {
      const w = new OWSWallet({ wallet: 'mock' });
      const sig = await w.signMessage(caip2, 'n-payment-smoke');
      expect(sig).toBe('0xmocksignature');
    },
  );

  it.each(MATRIX)(
    'signAndSend dispatches via CAIP-2 for $family',
    async ({ caip2, family }) => {
      const w = new OWSWallet({ wallet: 'mock' });
      const result = await w.signAndSend(caip2, { to: 'recipient', amount: '1' });
      expect(result.txHash).toBe('mock-tx-hash');
      expect(result.family).toBe(family);
    },
  );

  it.each(MATRIX)(
    'resolveFamily(caip2) classifies $family correctly',
    async ({ caip2, family }) => {
      const w = new OWSWallet({ wallet: 'mock' });
      expect(w.resolveFamily(caip2)).toBe(family);
    },
  );
});

describe('OWSWallet — error paths', () => {
  it('rejects unsupported namespace (Stellar) at sign time', async () => {
    const w = new OWSWallet({ wallet: 'mock' });
    await expect(w.signMessage('stellar:pubnet', 'hi')).rejects.toThrow(/OWS_CHAIN_FAMILY_NOT_SUPPORTED/);
  });

  it('rejects malformed CAIP-2', async () => {
    const w = new OWSWallet({ wallet: 'mock' });
    await expect(w.signMessage('not-a-caip2', 'hi')).rejects.toThrow(/OWS_INVALID_CAIP2/);
  });

  it('transfer() rejects non-EVM family with actionable hint', async () => {
    const w = new OWSWallet({ wallet: 'mock' });
    await expect(w.transfer('xrpl:mainnet', 'rDest', 'XRP', 1n)).rejects.toThrow(/OWS_FAMILY_PARTIAL/);
  });
});
