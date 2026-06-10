/**
 * v0.25 — CeloFeeAbstractedTransactor unit tests.
 *
 * Mocks viem's createPublicClient + createWalletClient at the module level so
 * we can assert on the exact `feeCurrency` field passed to writeContract.
 * No network I/O. Coverage > 90% on src/celo/fee-abstraction.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FAKE_TX_HASH = '0xfacefacefacefacefacefacefacefacefacefacefacefacefacefacefaceface' as const;

const writeContractMock = vi.fn(async () => FAKE_TX_HASH);
const waitForReceiptMock = vi.fn(async () => ({ blockNumber: 42n, status: 'success' as const }));

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      waitForTransactionReceipt: waitForReceiptMock,
    }),
    createWalletClient: () => ({
      account: { address: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' },
      chain: { id: 42220 },
      writeContract: writeContractMock,
    }),
  };
});

import { CeloFeeAbstractedTransactor } from '../src/celo/fee-abstraction.js';
import { CeloFeeAbstractedAdapter } from '../src/adapters/celo-fee-abstracted.js';
import { OWSWallet } from '../src/ows/wallet.js';
import { NPaymentError } from '../src/errors.js';

describe('CeloFeeAbstractedTransactor — getFeeCurrency', () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    waitForReceiptMock.mockClear();
  });

  it('resolves USDC fee adapter on celo mainnet by default', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet');
    expect(t.getFeeCurrency()?.toLowerCase()).toBe('0x2f25deb3848c207fc8e0c34035b3ba7fc157602b');
  });

  it('resolves USDC fee adapter on celo sepolia', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-sepolia');
    expect(t.getFeeCurrency()?.toLowerCase()).toBe('0x4822e58de6f5e485ef90df51c41ce01721331dc0');
  });

  it('resolves USDT fee adapter when payAsset=USDT on mainnet', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'USDT');
    expect(t.getFeeCurrency()?.toLowerCase()).toBe('0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72');
  });

  it('USDT on sepolia throws CELO_FEE_ABSTRACTION_REJECTED (mainnet only in v0.25)', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-sepolia', 'USDT');
    expect(() => t.getFeeCurrency()).toThrow(/CELO_FEE_ABSTRACTION_REJECTED|USDT_FEE_ADAPTER/);
  });

  it('resolves USDm token addr directly (no separate adapter)', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'USDm');
    expect(t.getFeeCurrency()?.toLowerCase()).toBe('0x765de816845861e75a25fca122bb6898b8b1282a');
  });

  it('honors adapterOverride above all', () => {
    const override = '0xDEADBEEFdeadbeefDeadBeefdEadbEefdEAdBeEf' as const;
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'USDC', { adapterOverride: override });
    expect(t.getFeeCurrency()).toBe(override);
  });

  it('returns undefined when disabled (callers should fall back to native CELO)', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'USDC', { disabled: true });
    expect(t.getFeeCurrency()).toBeUndefined();
  });

  it('throws INVALID_PAY_ASSET for unsupported asset symbol', () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'EUR' as never);
    expect(() => t.getFeeCurrency()).toThrow(NPaymentError);
  });
});

describe('CeloFeeAbstractedTransactor — writeContract', () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    waitForReceiptMock.mockClear();
  });

  it('injects feeCurrency into the viem write call', async () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet');
    const { txHash, blockNumber } = await t.writeContract({
      address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      abi: [],
      functionName: 'transfer',
      args: ['0x0000000000000000000000000000000000000001', 1n],
    });
    expect(txHash).toBe(FAKE_TX_HASH);
    expect(blockNumber).toBe(42n);
    expect(writeContractMock).toHaveBeenCalledTimes(1);
    const call = writeContractMock.mock.calls[0][0] as { feeCurrency?: string };
    expect(call.feeCurrency?.toLowerCase()).toBe('0x2f25deb3848c207fc8e0c34035b3ba7fc157602b');
  });

  it('omits feeCurrency when disabled', async () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'USDC', { disabled: true });
    await t.writeContract({
      address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      abi: [], functionName: 'transfer', args: [],
    });
    const call = writeContractMock.mock.calls[0][0] as { feeCurrency?: string };
    expect(call.feeCurrency).toBeUndefined();
  });
});

describe('CeloFeeAbstractedTransactor — transferWithAuthorization', () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    waitForReceiptMock.mockClear();
  });

  it('settles EIP-3009 with feeCurrency wrapping', async () => {
    const t = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-sepolia');
    const sig = ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as `0x${string}`;
    const { txHash } = await t.transferWithAuthorization({
      token: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
      from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      value: 10_000n,
      validAfter: 0n,
      validBefore: 9_999_999_999n,
      nonce: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      signature: sig,
    });
    expect(txHash).toBe(FAKE_TX_HASH);
    const call = writeContractMock.mock.calls[0][0] as { functionName: string; args: unknown[]; feeCurrency?: string };
    expect(call.functionName).toBe('transferWithAuthorization');
    expect(call.args).toHaveLength(9);
    expect(call.feeCurrency?.toLowerCase()).toBe('0x4822e58de6f5e485ef90df51c41ce01721331dc0');
  });
});

// ─── CeloFeeAbstractedAdapter (Task 3) ──────────────────────────────────────

describe('CeloFeeAbstractedAdapter — buyer flow', () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    waitForReceiptMock.mockClear();
  });

  it('detects x402 challenge headers (delegates to inner X402Adapter)', () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_PRIVATE_KEY });
    const adapter = new CeloFeeAbstractedAdapter(wallet, 'celo-mainnet', { payAsset: 'USDC' });
    const r = new Response(null, { status: 402, headers: { 'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' } });
    expect(adapter.detect(r)).toBe(true);
    const r2 = new Response(null, { status: 402, headers: {} });
    expect(adapter.detect(r2)).toBe(false);
  });

  it('decodeXPayment parses a buyer envelope into typed authorization + signature', () => {
    const envelope = {
      x402Version: 2, scheme: 'exact', network: 'eip155:42220',
      payload: {
        signature: '0x' + '11'.repeat(65),
        authorization: {
          from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          value: '10000', validAfter: '0', validBefore: '9999999999',
          nonce: '0x' + 'aa'.repeat(32),
        },
      },
    };
    const b64 = Buffer.from(JSON.stringify(envelope)).toString('base64');
    const decoded = CeloFeeAbstractedAdapter.decodeXPayment(b64);
    expect(decoded.authorization.value).toBe(10_000n);
    expect(decoded.authorization.validBefore).toBe(9_999_999_999n);
    expect(decoded.network).toBe('eip155:42220');
  });

  it('decodeXPayment throws INVALID_HEADER on malformed payload', () => {
    expect(() => CeloFeeAbstractedAdapter.decodeXPayment('not-base64-json')).toThrow();
  });
});

describe('CeloFeeAbstractedAdapter — merchant flow', () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    waitForReceiptMock.mockClear();
  });

  it('verifyAndSettle throws CELO_NO_MERCHANT_SIGNER until setMerchantSigner is called', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_PRIVATE_KEY });
    const adapter = new CeloFeeAbstractedAdapter(wallet, 'celo-sepolia', {});
    await expect(
      adapter.verifyAndSettle({
        authorization: {
          from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          value: 100n, validAfter: 0n, validBefore: 9_999_999_999n,
          nonce: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
        },
        signature: ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as `0x${string}`,
      }),
    ).rejects.toThrow(/Merchant signer not wired/);
  });

  it('verifyAndSettle injects feeCurrency on the EIP-3009 settlement', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_PRIVATE_KEY });
    const adapter = new CeloFeeAbstractedAdapter(wallet, 'celo-sepolia', {});
    adapter.setMerchantSigner(TEST_PRIVATE_KEY, 'USDC');
    const result = await adapter.verifyAndSettle({
      authorization: {
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        value: 10_000n, validAfter: 0n, validBefore: 9_999_999_999n,
        nonce: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      },
      signature: ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as `0x${string}`,
    });
    expect(result.txHash).toBe(FAKE_TX_HASH);
    expect(result.feeCurrency?.toLowerCase()).toBe('0x4822e58de6f5e485ef90df51c41ce01721331dc0');
    const call = writeContractMock.mock.calls[0][0] as { functionName: string; feeCurrency?: string };
    expect(call.functionName).toBe('transferWithAuthorization');
    expect(call.feeCurrency?.toLowerCase()).toBe('0x4822e58de6f5e485ef90df51c41ce01721331dc0');
  });

  it('verifyAndSettle with disableFeeAbstraction omits feeCurrency (falls back to native CELO gas)', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_PRIVATE_KEY });
    const adapter = new CeloFeeAbstractedAdapter(wallet, 'celo-sepolia', { disableFeeAbstraction: true });
    adapter.setMerchantSigner(TEST_PRIVATE_KEY, 'USDC');
    const result = await adapter.verifyAndSettle({
      authorization: {
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        value: 10_000n, validAfter: 0n, validBefore: 9_999_999_999n,
        nonce: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
      },
      signature: ('0x' + '11'.repeat(32) + '22'.repeat(32) + '1b') as `0x${string}`,
    });
    expect(result.feeCurrency).toBeUndefined();
    const call = writeContractMock.mock.calls[0][0] as { feeCurrency?: string };
    expect(call.feeCurrency).toBeUndefined();
  });

  it('verifyAndSettle honors token override for USDT settlement', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_PRIVATE_KEY });
    const adapter = new CeloFeeAbstractedAdapter(wallet, 'celo-mainnet', {});
    adapter.setMerchantSigner(TEST_PRIVATE_KEY, 'USDT');
    const usdtCelo = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e' as const;
    await adapter.verifyAndSettle({
      authorization: {
        from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        value: 10_000n, validAfter: 0n, validBefore: 9_999_999_999n,
        nonce: ('0x' + 'bb'.repeat(32)) as `0x${string}`,
      },
      signature: ('0x' + '33'.repeat(32) + '44'.repeat(32) + '1c') as `0x${string}`,
      token: usdtCelo,
    });
    const call = writeContractMock.mock.calls[0][0] as { address: string; feeCurrency?: string };
    expect(call.address.toLowerCase()).toBe(usdtCelo);
    expect(call.feeCurrency?.toLowerCase()).toBe('0x0e2a3e05bc9a16f5292a6170456a710cb89c6f72');
  });
});
