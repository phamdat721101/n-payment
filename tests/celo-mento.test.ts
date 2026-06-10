/**
 * v0.25 — Mento corridor + broker client unit tests.
 *
 * Mocks viem at the module level for MentoBrokerClient construction; the
 * `selectMentoCorridor` pure function is tested with an injected mock broker
 * (no viem mock needed for path selection).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const FAKE_TX_HASH = '0xfeeefeeefeeefeeefeeefeeefeeefeeefeeefeeefeeefeeefeeefeeefeeefeee' as const;

const writeContractMock = vi.fn(async () => FAKE_TX_HASH);
const waitForReceiptMock = vi.fn(async () => ({ blockNumber: 99n, status: 'success' as const }));
const readContractMock = vi.fn(async () => 0n);

vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: readContractMock,
      waitForTransactionReceipt: waitForReceiptMock,
    }),
    createWalletClient: () => ({
      writeContract: writeContractMock,
    }),
  };
});

import {
  MENTO_ASSETS,
  selectMentoCorridor,
  type MentoCorridorInput,
} from '../src/celo/mento.js';
import { MentoBrokerClient } from '../src/celo/mento-broker.js';
import { CeloFeeAbstractedTransactor } from '../src/celo/fee-abstraction.js';

const USDC = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' as const;
const FAKE_PROVIDER = '0x0000000000000000000000000000000000001234' as const;
const FAKE_EXCHANGE_ID = ('0x' + 'cd'.repeat(32)) as `0x${string}`;
const resolveExchange = () => ({ provider: FAKE_PROVIDER, exchangeId: FAKE_EXCHANGE_ID });

// Mock broker that returns deterministic quotes for unit tests.
function mkMockBroker(quote: (tIn: string, tOut: string, amt: bigint) => bigint) {
  return {
    async getAmountOut(tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint) {
      return quote(tokenIn.toLowerCase(), tokenOut.toLowerCase(), amountIn);
    },
  };
}

describe('selectMentoCorridor — direct USDm → USDC', () => {
  it('returns direct-mento decision with computed slippage', async () => {
    const broker = mkMockBroker((_in, _out, amt) => (amt * 9_995n) / 10_000n); // 5 bps loss
    const decision = await selectMentoCorridor({
      assetIn: 'USDm', assetOut: 'USDC',
      amountIn: 1000n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('direct-mento');
    if (decision.kind === 'direct-mento') {
      expect(decision.slippageBps).toBe(5);
      expect(decision.legs[0].assetOut).toBe('USDC');
    }
  });

  it('rejects when slippage exceeds default 50 bps', async () => {
    const broker = mkMockBroker((_in, _out, amt) => (amt * 9_900n) / 10_000n); // 100 bps loss
    const decision = await selectMentoCorridor({
      assetIn: 'USDm', assetOut: 'USDC', amountIn: 1000n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('no-route');
    if (decision.kind === 'no-route') expect(decision.reason).toContain('slippage');
  });

  it('honors custom slippage cap', async () => {
    const broker = mkMockBroker((_in, _out, amt) => (amt * 9_900n) / 10_000n); // 100 bps loss
    const decision = await selectMentoCorridor({
      assetIn: 'USDm', assetOut: 'USDC', amountIn: 1000n * 10n ** 18n, broker,
      maxSlippageBps: 150,
    });
    expect(decision.kind).toBe('direct-mento');
  });
});

describe('selectMentoCorridor — two-leg cKES/cREAL → USDC', () => {
  it('cKES → USDC via USDm produces 2 legs', async () => {
    // Synthetic quote: cKES = 0.0078 USDm, USDm = 1 USDC
    const broker = mkMockBroker((_in, out, amt) => {
      // For our test we don't need exact Mento math — we return a pass-through
      // for the USDm→USDC leg and a 0.0078 ratio for cKES→USDm.
      const o = out.toLowerCase();
      const usdm = MENTO_ASSETS.USDm.address.toLowerCase();
      const usdc = USDC.toLowerCase();
      if (o === usdm) return (amt * 78n) / 10_000n;       // cKES → USDm at 0.0078
      if (o === usdc) return (amt * 9_999n) / 10_000n;    // USDm → USDC at ~1:1, 1 bps loss
      return 0n;
    });
    const decision = await selectMentoCorridor({
      assetIn: 'cKES', assetOut: 'USDC', amountIn: 100_000n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('via-usdm');
    if (decision.kind === 'via-usdm') {
      expect(decision.legs).toHaveLength(2);
      expect(decision.legs[0].assetIn).toBe('cKES');
      expect(decision.legs[0].assetOut).toBe('USDm');
      expect(decision.legs[1].assetIn).toBe('USDm');
      expect(decision.legs[1].assetOut).toBe('USDC');
    }
  });

  it('cREAL → USDC via USDm', async () => {
    const broker = mkMockBroker((_in, out, amt) => {
      if (out === MENTO_ASSETS.USDm.address.toLowerCase()) return (amt * 1_900n) / 10_000n; // cREAL ~ 0.19 USD
      if (out === USDC.toLowerCase()) return (amt * 9_999n) / 10_000n;
      return 0n;
    });
    const decision = await selectMentoCorridor({
      assetIn: 'cREAL', assetOut: 'USDC', amountIn: 1_000n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('via-usdm');
  });

  it('returns no-route when broker reverts (circuit breaker)', async () => {
    const broker: { getAmountOut: typeof MentoBrokerClient.prototype.getAmountOut } = {
      async getAmountOut() { throw new Error('Mento: paused'); },
    };
    const decision = await selectMentoCorridor({
      assetIn: 'cKES', assetOut: 'USDC', amountIn: 100n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('no-route');
    if (decision.kind === 'no-route') expect(decision.reason).toBe('mento-circuit-breaker');
  });

  it('returns no-route when broker returns zero on leg2', async () => {
    const broker = mkMockBroker((_in, out, amt) => {
      if (out === MENTO_ASSETS.USDm.address.toLowerCase()) return amt;
      return 0n;
    });
    const decision = await selectMentoCorridor({
      assetIn: 'cKES', assetOut: 'USDC', amountIn: 100n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('no-route');
  });

  it('rejects unsupported pair', async () => {
    const broker = mkMockBroker(() => 1n);
    const decision = await selectMentoCorridor({
      assetIn: 'cKES', assetOut: 'cREAL' as never, amountIn: 100n * 10n ** 18n, broker,
    });
    expect(decision.kind).toBe('no-route');
  });

  it('rejects non-positive amountIn', async () => {
    const broker = mkMockBroker(() => 0n);
    const decision = await selectMentoCorridor({
      assetIn: 'USDm', assetOut: 'USDC', amountIn: 0n, broker,
    });
    expect(decision.kind).toBe('no-route');
  });

  it('honors caller minOut hint', async () => {
    const broker = mkMockBroker((_in, _out, amt) => (amt * 9_999n) / 10_000n);
    const decision = await selectMentoCorridor({
      assetIn: 'USDm', assetOut: 'USDC', amountIn: 1_000n * 10n ** 18n, broker,
      minOut: 999_999n * 10n ** 18n, // unrealistically high
    });
    expect(decision.kind).toBe('no-route');
  });
});

describe('MentoBrokerClient', () => {
  beforeEach(() => {
    writeContractMock.mockClear();
    waitForReceiptMock.mockClear();
    readContractMock.mockClear();
  });

  it('throws when broker address missing on testnet (MENTO_BROKER not registered)', () => {
    expect(
      () => new MentoBrokerClient('celo-sepolia', { resolveExchange }),
    ).toThrow(/CELO_MENTO_BROKER_MISSING|broker address/i);
  });

  it('reads getAmountOut from on-chain Mento broker', async () => {
    readContractMock.mockResolvedValueOnce(987_654n * 10n ** 14n);
    const client = new MentoBrokerClient('celo-mainnet', { resolveExchange });
    const out = await client.getAmountOut(
      MENTO_ASSETS.USDm.address,
      USDC,
      1_000_000n * 10n ** 14n,
    );
    expect(out).toBe(987_654n * 10n ** 14n);
    const call = readContractMock.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(call.functionName).toBe('getAmountOut');
    expect(call.args).toHaveLength(5);
  });

  it('swapIn routes the call through CeloFeeAbstractedTransactor (CIP-64 wrapped)', async () => {
    const client = new MentoBrokerClient('celo-mainnet', { resolveExchange });
    const transactor = new CeloFeeAbstractedTransactor(TEST_PRIVATE_KEY, 'celo-mainnet', 'USDm');
    const result = await client.swapIn(
      transactor,
      MENTO_ASSETS.USDm.address,
      USDC,
      1_000n * 10n ** 18n,
      900n * 10n ** 18n,
    );
    expect(result.txHash).toBe(FAKE_TX_HASH);
    const call = writeContractMock.mock.calls[0][0] as { functionName: string; feeCurrency?: string };
    expect(call.functionName).toBe('swapIn');
    // USDm pays its own gas (CIP-66 — token IS its own fee currency).
    expect(call.feeCurrency?.toLowerCase()).toBe(MENTO_ASSETS.USDm.address.toLowerCase());
  });

  it('honors brokerOverride at construction time', () => {
    const override = '0xDEADBEEFdeadbeefDEADBEEFdeadbeefDEADBEEF' as const;
    const client = new MentoBrokerClient('celo-mainnet', { resolveExchange, brokerOverride: override });
    expect(client.getBrokerAddress()).toBe(override);
  });
});
