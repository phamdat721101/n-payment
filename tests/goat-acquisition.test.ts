import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GoatTokens,
  MockSwapAdapter,
  MockOftAdapter,
  MockBridgeAdapter,
  BalanceSheetStrategy,
  UsdcAcquisitionRouter,
  GoatAcquisitionPresets,
  goatError,
  GOAT_ACQUISITION_HINTS,
  type AcquisitionPathAdapter,
  type BalanceSheet,
} from '../src/index.js';
import { PsbtValidator } from '../src/goat/paths.js';
import { SpendingGuard, PolicyEngine, AuditLog } from '../src/policy/index.js';

// ─── GoatTokens ──────────────────────────────────────────────────────────────

describe('GoatTokens', () => {
  it('uses usdcOverride when provided and emits a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new GoatTokens('goat-mainnet', { usdcOverride: '0xAbCdef0123456789012345678901234567890123' });
    expect(t.resolve('USDC').toLowerCase()).toBe('0xabcdef0123456789012345678901234567890123');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws GOAT_USDC_NOT_RESOLVED for unset USDC on mainnet', () => {
    const t = new GoatTokens('goat-mainnet');
    expect(() => t.resolve('USDC')).toThrow(/GOAT_USDC_NOT_RESOLVED/);
  });

  it('resolves PegBTC from chains.ts on goat-mainnet', () => {
    const t = new GoatTokens('goat-mainnet');
    expect(t.resolve('PegBTC')).toBe('0xbC10000000000000000000000000000000000000');
    expect(t.has('PegBTC')).toBe(true);
  });

  it('reports has() false for unresolved symbols', () => {
    const t = new GoatTokens('goat-mainnet');
    expect(t.has('USDC')).toBe(false);
  });
});

// ─── Mock adapters ───────────────────────────────────────────────────────────

describe('Mock adapters', () => {
  it('MockSwapAdapter quotes and executes deterministically', async () => {
    const a = new MockSwapAdapter();
    const q = await a.quote(1_000_000n);
    expect(q.path).toBe('swap');
    expect(q.usdcOut).toBe(1_000_000n);
    expect(q.feeBps).toBe(30);
    const r = await a.execute(q);
    expect(r.usdcAcquired).toBe(1_000_000n);
    expect(r.srcTxHash).toMatch(/^0xmock-swap-/);
  });

  it('MockOftAdapter quotes per src chain', async () => {
    const a = new MockOftAdapter({ srcChain: 'base-mainnet' });
    const q = await a.quote(2_000_000n);
    expect(q.sourceChain).toBe('base-mainnet');
    expect(q.usdcOut).toBe(2_000_000n);
  });

  it('MockBridgeAdapter quotes and executes', async () => {
    const a = new MockBridgeAdapter();
    const q = await a.quote(5_000_000n);
    expect(q.path).toBe('pegin');
    expect(q.sourceChain).toBe('btc');
    const r = await a.execute(q);
    expect(r.path).toBe('pegin');
  });
});

// ─── PsbtValidator (gstack /cso S1) ──────────────────────────────────────────

describe('PsbtValidator', () => {
  const goodIntent = {
    intentId: 'i1',
    depositAddress: 'tb1qfaketestaddrxxxxxx',
    expectedAmountSats: 50_000n,
    expiry: Date.now() + 60_000,
    recipientGoat: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
  };

  it('accepts a well-formed intent + tx hex', () => {
    expect(() => PsbtValidator.assertOutputsMatchIntent('0x010203', goodIntent)).not.toThrow();
  });

  it('rejects missing depositAddress', () => {
    expect(() =>
      PsbtValidator.assertOutputsMatchIntent('0x', { ...goodIntent, depositAddress: '' }),
    ).toThrow(/GOAT_BRIDGE_PSBT_TAMPERED/);
  });

  it('rejects non-positive expectedAmountSats', () => {
    expect(() =>
      PsbtValidator.assertOutputsMatchIntent('0x', { ...goodIntent, expectedAmountSats: 0n }),
    ).toThrow(/GOAT_BRIDGE_PSBT_TAMPERED/);
  });

  it('rejects zero recipientGoat', () => {
    expect(() =>
      PsbtValidator.assertOutputsMatchIntent('0x', {
        ...goodIntent,
        recipientGoat: '0x0000000000000000000000000000000000000000',
      }),
    ).toThrow(/GOAT_BRIDGE_PSBT_TAMPERED/);
  });
});

// ─── BalanceSheetStrategy decision matrix ────────────────────────────────────

describe('BalanceSheetStrategy', () => {
  const strategy = new BalanceSheetStrategy();
  const swap = new MockSwapAdapter();
  const oft = new MockOftAdapter({ srcChain: 'base-mainnet' });
  const pegin = new MockBridgeAdapter();
  const all: AcquisitionPathAdapter[] = [swap, oft, pegin];

  it('picks swap when PegBTC available', async () => {
    const balances: BalanceSheet = { pegbtcOnGoat: 1_000_000_000_000n, usdcOnGoat: 0n, usdcByChain: {} };
    const decision = await strategy.decide(balances, 1_000_000n, all, { allowedPaths: ['swap', 'oft', 'pegin'] });
    expect(decision.path).toBe('swap');
  });

  it('picks oft when only partner-chain USDC', async () => {
    const balances: BalanceSheet = { pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: { 'base-mainnet': 100_000_000n } };
    const decision = await strategy.decide(balances, 5_000_000n, all, { allowedPaths: ['swap', 'oft', 'pegin'] });
    expect(decision.path).toBe('oft');
  });

  it('picks pegin when only BTC L1', async () => {
    const balances: BalanceSheet = { pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: {}, btcL1Sats: 100_000n };
    const decision = await strategy.decide(balances, 1_000_000n, all, { allowedPaths: ['swap', 'oft', 'pegin'] });
    expect(decision.path).toBe('pegin');
  });

  it('respects allowedPaths — refuses disallowed even when balance fits', async () => {
    const balances: BalanceSheet = { pegbtcOnGoat: 1_000_000_000_000n, usdcOnGoat: 0n, usdcByChain: {} };
    await expect(
      strategy.decide(balances, 1_000_000n, all, { allowedPaths: ['oft'] }),
    ).rejects.toThrow(/GOAT_NO_VIABLE_PATH/);
  });

  it('throws GOAT_NO_VIABLE_PATH when nothing fits', async () => {
    const balances: BalanceSheet = { pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: {} };
    await expect(
      strategy.decide(balances, 1_000_000n, all, { allowedPaths: ['swap', 'oft', 'pegin'] }),
    ).rejects.toThrow(/GOAT_NO_VIABLE_PATH/);
  });
});

// ─── UsdcAcquisitionRouter ───────────────────────────────────────────────────

describe('UsdcAcquisitionRouter', () => {
  const fakeWallet = {
    getAddressAsync: vi.fn(async () => '0x000000000000000000000000000000000000bEEF'),
    getBalance: vi.fn(async () => 0n),
  } as any;

  function makeRouter(
    cfgOverride: Partial<Parameters<typeof GoatAcquisitionPresets.testnet>[0] extends never ? any : any> = {},
    extraDeps: { guard?: SpendingGuard } = {},
  ) {
    const config = { ...GoatAcquisitionPresets.testnet(), ...cfgOverride };
    return new UsdcAcquisitionRouter({
      goatChain: 'goat-testnet',
      wallet: fakeWallet,
      config,
      mockMode: true,
      partnerChains: ['base-mainnet'],
      ...extraDeps,
    });
  }

  beforeEach(() => {
    fakeWallet.getAddressAsync.mockClear();
  });

  it('zero-target returns no-op', async () => {
    const router = makeRouter();
    // Stub balance read — router needs a balance sheet even to compute partial-fill delta.
    (router as any).balances.read = async () => ({ pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: {} });
    const r = await router.acquire({ targetUsdcWei: 0n });
    expect(r.status).toBe('no-op');
    expect(r.acquired).toBe(0n);
  });

  it('partial-fill: only acquires the delta when partial USDC already on GOAT', async () => {
    const router = makeRouter();
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 600_000n, usdcByChain: {},
    });
    const r = await router.acquire({ targetUsdcWei: 1_000_000n });
    expect(r.status).toBe('executed');
    expect(r.acquired).toBe(400_000n); // 1.0 - 0.6 USDC
  });

  it('dry-run returns quote without executing', async () => {
    const router = makeRouter();
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {},
    });
    const r = await router.acquire({ targetUsdcWei: 1_000_000n, dryRun: true });
    expect(r.status).toBe('dry-run');
    expect(r.acquired).toBe(0n);
    expect(r.quote?.path).toBe('swap');
    expect(r.receipt).toBeUndefined();
  });

  it('estimate() probes without executing and returns RoutingDecision', async () => {
    const router = makeRouter();
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {},
    });
    const decision = await router.estimate({ targetUsdcWei: 1_000_000n });
    expect(decision?.path).toBe('swap');
  });

  it('idempotency: same key returns cached receipt within window', async () => {
    const router = makeRouter();
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {},
    });
    const a = await router.acquire({ targetUsdcWei: 1_000_000n, idempotencyKey: 'key1' });
    const b = await router.acquire({ targetUsdcWei: 1_000_000n, idempotencyKey: 'key1' });
    expect(b.correlationId).toBe(a.correlationId); // exact same result returned from cache
  });

  it('mutex: parallel acquires serialise', async () => {
    const router = makeRouter();
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {},
    });
    const results = await Promise.all([
      router.acquire({ targetUsdcWei: 1_000_000n }),
      router.acquire({ targetUsdcWei: 2_000_000n }),
    ]);
    expect(results[0].status).toBe('executed');
    expect(results[1].status).toBe('executed');
    expect(results[0].correlationId).not.toBe(results[1].correlationId);
  });

  it('throws GOAT_AUTOFUND_DISABLED when not enabled (and not dry-run)', async () => {
    const router = makeRouter({ enabled: false });
    await expect(router.acquire({ targetUsdcWei: 1_000_000n })).rejects.toThrow(/GOAT_AUTOFUND_DISABLED/);
  });

  it('enforces per-hour cap via SpendingGuard', async () => {
    const guard = new SpendingGuard(new PolicyEngine([]), new AuditLog());
    const router = makeRouter({ maxPerHour: 100_000n }, { guard });
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {},
    });
    await expect(router.acquire({ targetUsdcWei: 1_000_000n })).rejects.toThrow(/GOAT_AUTOFUND_LIMIT_EXCEEDED/);
  });

  it('emits an audit acquisition entry on successful execute', async () => {
    const guard = new SpendingGuard(new PolicyEngine([]), new AuditLog());
    const router = makeRouter({}, { guard });
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {},
    });
    await router.acquire({ targetUsdcWei: 1_000_000n });
    const entries = guard.getAudit().query({ type: 'acquisition' });
    expect(entries.length).toBe(1);
    expect(entries[0].acquisitionPath).toBe('swap');
    expect(entries[0].amount).toBe(1_000_000n);
  });

  it('throws GOAT_NO_VIABLE_PATH when no balances cover the target', async () => {
    const router = makeRouter();
    (router as any).balances.read = async () => ({
      pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: {},
    });
    await expect(router.acquire({ targetUsdcWei: 1_000_000n })).rejects.toThrow(/GOAT_NO_VIABLE_PATH/);
  });
});

// ─── Presets ─────────────────────────────────────────────────────────────────

describe('GoatAcquisitionPresets', () => {
  it('safeDefaults: swap+oft, $1/hr, $10/day, 1% fee, 0.5% slippage', () => {
    const p = GoatAcquisitionPresets.safeDefaults();
    expect(p.enabled).toBe(true);
    expect(p.allowedPaths).toEqual(['swap', 'oft']);
    expect(p.maxPerHour).toBe(1_000_000n);
    expect(p.maxPerDay).toBe(10_000_000n);
    expect(p.maxFeeBps).toBe(100);
    expect(p.maxSlippageBps).toBe(50);
  });

  it('swapOnly: only the swap path allowed', () => {
    expect(GoatAcquisitionPresets.swapOnly().allowedPaths).toEqual(['swap']);
  });

  it('peginOnly: only the pegin path allowed', () => {
    expect(GoatAcquisitionPresets.peginOnly().allowedPaths).toEqual(['pegin']);
  });

  it('aggressive: all three paths and high caps', () => {
    const p = GoatAcquisitionPresets.aggressive();
    expect(p.allowedPaths).toEqual(['swap', 'oft', 'pegin']);
    expect(p.maxPerHour).toBeGreaterThanOrEqual(100_000_000n);
  });

  it('testnet: enabled with all paths and inflated caps', () => {
    const p = GoatAcquisitionPresets.testnet();
    expect(p.enabled).toBe(true);
    expect(p.allowedPaths).toEqual(['swap', 'oft', 'pegin']);
  });
});

// ─── Error-hint completeness (gstack /plan-devex-review D4) ──────────────────

describe('GOAT_ACQUISITION_HINTS', () => {
  it('every code has a non-empty actionable hint', () => {
    const codes = Object.keys(GOAT_ACQUISITION_HINTS);
    expect(codes.length).toBeGreaterThanOrEqual(15);
    for (const code of codes) {
      const hint = GOAT_ACQUISITION_HINTS[code];
      expect(hint.length).toBeGreaterThan(20);
      // Hint should start with an actionable verb (Set / Top / Pass / Wait / Increase / Install / Re- / Check / Track / Fund / Bridge).
      expect(hint).toMatch(/^(Set|Top|Pass|Wait|Increase|Install|Re-|Check|Track|Fund|Bridge|Each|Track)/);
    }
  });

  it('goatError() factory carries the canonical hint and embeds the code', () => {
    const err = goatError('GOAT_NO_VIABLE_PATH', 'context');
    expect(err.code).toBe('GOAT_NO_VIABLE_PATH');
    expect(err.hint).toBe(GOAT_ACQUISITION_HINTS.GOAT_NO_VIABLE_PATH);
    expect(err.message).toBe('GOAT_NO_VIABLE_PATH: context');
    // Without context: message === code
    expect(goatError('GOAT_AUTOFUND_DISABLED').message).toBe('GOAT_AUTOFUND_DISABLED');
  });
});
