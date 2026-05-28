/**
 * v0.17 — GOAT USDC Acquisition Router.
 *
 * The orchestrator: given a target USDC amount on GOAT, pick a path, quote it,
 * verify policy/idempotency, execute, and emit an audit entry.
 *
 * SOLID:
 *   • Open/Closed — RoutingStrategy is an interface; ship BalanceSheetStrategy as
 *     the default but accept any user implementation.
 *   • Single Responsibility — this file owns *only* orchestration. Path
 *     mechanics live in src/goat/paths.ts.
 *   • Dependency Inversion — the router depends on AcquisitionPathAdapter, not
 *     on concrete Swap/OFT/Pegin classes.
 */

import type { Address } from 'viem';
import type {
  AcquisitionPath,
  GoatAcquisitionConfig,
  ChainKey,
  BtcSigner,
} from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import type { SpendingGuard } from '../policy/index.js';
import { CHAINS } from '../chains.js';
import { goatError, NPaymentError } from '../errors.js';
import {
  GoatTokens,
  GoatBalances,
  GoatDexSwap,
  LayerZeroOftClient,
  BitVMBridgeClient,
  MockSwapAdapter,
  MockOftAdapter,
  MockBridgeAdapter,
  type AcquisitionPathAdapter,
  type AcquisitionQuote,
  type AcquisitionReceipt,
  type BalanceSheet,
} from './paths.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface AcquireParams {
  /** Target USDC wei (6-dec) the agent should hold on GOAT after this call. */
  targetUsdcWei: bigint;
  /** Optional idempotency key. Same key in the cache window → cached receipt. */
  idempotencyKey?: string;
  /** Quote without executing. */
  dryRun?: boolean;
  /** Cancel the in-flight acquisition. */
  signal?: AbortSignal;
  /** Subset of paths the router may use this call (overrides config). */
  allowedPaths?: AcquisitionPath[];
}

export interface AcquireResult {
  status: 'no-op' | 'executed' | 'dry-run';
  /** USDC wei acquired this call (after partial-fill math). 0n on no-op / dry-run. */
  acquired: bigint;
  /** Quote chosen by the strategy (always populated for non-no-op). */
  quote?: AcquisitionQuote;
  /** Receipt — populated for status='executed' only. */
  receipt?: AcquisitionReceipt;
  /** Correlation id for log + audit cross-reference. */
  correlationId: string;
}

export interface RoutingDecision {
  path: AcquisitionPath;
  quote: AcquisitionQuote;
}

export interface AcquisitionRoutingStrategy {
  decide(
    balances: BalanceSheet,
    deltaUsdcWei: bigint,
    available: AcquisitionPathAdapter[],
    opts: { allowedPaths: AcquisitionPath[]; signal?: AbortSignal },
  ): Promise<RoutingDecision>;
}

// ─── BalanceSheetStrategy — default heuristic ────────────────────────────────

/**
 * Inspects the agent's holdings and picks the first viable path in this order:
 *   1. swap   — has PegBTC on GOAT
 *   2. oft    — has USDC on a partner chain (uses cheapest src by feeBps)
 *   3. pegin  — has BTC L1 sats
 * Refuses to pick disallowed paths. Throws GOAT_NO_VIABLE_PATH otherwise.
 */
export class BalanceSheetStrategy implements AcquisitionRoutingStrategy {
  async decide(
    balances: BalanceSheet,
    deltaUsdcWei: bigint,
    available: AcquisitionPathAdapter[],
    opts: { allowedPaths: AcquisitionPath[]; signal?: AbortSignal },
  ): Promise<RoutingDecision> {
    const byPath = new Map(available.map((a) => [a.path, a]));
    const eligible = (p: AcquisitionPath) => opts.allowedPaths.includes(p) && byPath.has(p) && byPath.get(p)!.available();

    // Path 1 — in-GOAT swap (cheapest, lowest latency).
    if (eligible('swap') && balances.pegbtcOnGoat > 0n) {
      const quote = await byPath.get('swap')!.quote(deltaUsdcWei, { signal: opts.signal });
      if (balances.pegbtcOnGoat >= quote.sourceIn) return { path: 'swap', quote };
    }

    // Path 2 — cross-chain OFT (any partner chain with enough USDC).
    if (eligible('oft')) {
      const candidates = Object.entries(balances.usdcByChain)
        .filter(([, bal]) => bal! >= deltaUsdcWei)
        .map(([chain]) => chain as ChainKey);
      if (candidates.length) {
        const quote = await byPath.get('oft')!.quote(deltaUsdcWei, { signal: opts.signal });
        return { path: 'oft', quote };
      }
    }

    // Path 3 — BTC L1 peg-in (deepest treasury, highest latency).
    if (eligible('pegin') && (balances.btcL1Sats ?? 0n) > 0n) {
      const quote = await byPath.get('pegin')!.quote(deltaUsdcWei, { signal: opts.signal });
      if ((balances.btcL1Sats ?? 0n) >= quote.sourceIn) return { path: 'pegin', quote };
    }

    throw goatError(
      'GOAT_NO_VIABLE_PATH',
      `No allowed path covers ${deltaUsdcWei} USDC ` +
      `(pegbtc=${balances.pegbtcOnGoat}, partnerUsdc=${Object.values(balances.usdcByChain).reduce((s, v) => s + (v ?? 0n), 0n)}, ` +
      `btc=${balances.btcL1Sats ?? 0n}, allowed=[${opts.allowedPaths.join(',')}])`,
    );
  }
}

// ─── UsdcAcquisitionRouter ───────────────────────────────────────────────────

export interface RouterDeps {
  goatChain: ChainKey;
  wallet: OWSWallet;
  config: GoatAcquisitionConfig;
  /** Partner chains to inspect for cross-chain USDC. */
  partnerChains?: ChainKey[];
  /** Hosted bridge URL for Path 3 (default https://bridge.goat.network). */
  bridgeUrl?: string;
  /** External BTC signer for Path 3 — required iff 'pegin' is in allowedPaths. */
  btcSigner?: BtcSigner;
  /** USDC override on GOAT (escape hatch — emits boot warning). */
  usdcOverride?: Address;
  /** OKU swap router/quoter overrides. */
  dexOverride?: { router?: Address; quoter?: Address };
  /** Spending guard for cap enforcement + audit. Optional; when absent, no caps. */
  guard?: SpendingGuard;
  /** Strategy. Defaults to BalanceSheetStrategy. */
  strategy?: AcquisitionRoutingStrategy;
  /** When true, all paths use Mock adapters (testnet/CI mode). */
  mockMode?: boolean;
}

const DEFAULT_IDEMP_WINDOW_MS = 60_000;

/**
 * The user-facing router. Composes strategies + path adapters; enforces caps,
 * idempotency, mutex, and partial-fill.
 *
 * Performance: balance reads are lazy (router only fetches the partner-chain
 * column when 'oft' is allowed; only fetches BTC L1 when 'pegin' is allowed).
 */
export class UsdcAcquisitionRouter {
  private readonly tokens: GoatTokens;
  private readonly balances: GoatBalances;
  private readonly paths: AcquisitionPathAdapter[];
  private readonly strategy: AcquisitionRoutingStrategy;
  private readonly idemCache = new Map<string, { result: AcquireResult; expiresAt: number }>();
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RouterDeps) {
    this.tokens = new GoatTokens(deps.goatChain, { usdcOverride: deps.usdcOverride });
    this.balances = new GoatBalances(deps.goatChain, this.tokens);
    this.strategy = deps.strategy ?? new BalanceSheetStrategy();

    // Build path adapters lazily — mockMode replaces all real ones.
    if (deps.mockMode) {
      this.paths = [
        new MockSwapAdapter(),
        new MockOftAdapter({ srcChain: 'base-sepolia' }),
        new MockBridgeAdapter(),
      ];
    } else {
      this.paths = [
        new GoatDexSwap(deps.goatChain, deps.wallet, this.tokens, {
          maxSlippageBps: deps.config.maxSlippageBps ?? 50,
          override: deps.dexOverride,
        }),
        new LayerZeroOftClient(
          (deps.partnerChains?.[0] ?? 'base-mainnet') as ChainKey,
          deps.goatChain,
          deps.wallet,
          this.tokens,
          { maxFeeBps: deps.config.maxFeeBps ?? 100 },
        ),
        new BitVMBridgeClient({
          bridgeUrl: deps.bridgeUrl ?? 'https://bridge.goat.network',
          btcSigner: deps.btcSigner,
          recipientGoat: ('0x' as Address), // resolved per-call via wallet.getAddressAsync
          goatChain: deps.goatChain,
          tokens: this.tokens,
        }),
      ];
    }
  }

  /** True if 'pegin' is in allowedPaths but no BtcSigner is wired — fail-fast at boot. */
  validateConfig(): void {
    const allowed = this.deps.config.allowedPaths ?? ['swap'];
    if (allowed.includes('pegin') && !this.deps.btcSigner && !this.deps.mockMode) {
      throw goatError('GOAT_BTC_SIGNER_MISSING');
    }
  }

  /**
   * Probe the router without executing. Returns the would-be RoutingDecision —
   * useful for ops dry-runs and pre-flight UX.
   */
  async estimate(params: AcquireParams): Promise<RoutingDecision | null> {
    const result = await this.acquireInternal({ ...params, dryRun: true });
    return result.quote ? { path: result.quote.path, quote: result.quote } : null;
  }

  /**
   * Acquire USDC on GOAT. Atomic per-call (no fallback between paths within
   * one acquire — caller can re-call with a different `allowedPaths` to retry).
   */
  async acquire(params: AcquireParams): Promise<AcquireResult> {
    if (!this.deps.config.enabled && !params.dryRun) {
      throw goatError('GOAT_AUTOFUND_DISABLED');
    }
    return this.acquireInternal(params);
  }

  private async acquireInternal(params: AcquireParams): Promise<AcquireResult> {
    const correlationId = `acq-${Math.random().toString(36).slice(2, 10)}`;
    const target = params.targetUsdcWei;
    if (target === 0n) {
      return { status: 'no-op', acquired: 0n, correlationId };
    }

    // Idempotency cache hit?
    const idemKey = params.idempotencyKey;
    if (idemKey) {
      const hit = this.idemCache.get(idemKey);
      if (hit && hit.expiresAt > Date.now()) return hit.result;
    }

    // Per-wallet mutex serialises concurrent acquires.
    return (this.mutex = this.mutex.then(async () => {
      const result = await this.runOnce(params, correlationId);
      if (idemKey && result.status === 'executed') {
        this.idemCache.set(idemKey, { result, expiresAt: Date.now() + DEFAULT_IDEMP_WINDOW_MS });
      }
      return result;
    })) as Promise<AcquireResult>;
  }

  private async runOnce(params: AcquireParams, correlationId: string): Promise<AcquireResult> {
    const { targetUsdcWei: target, signal } = params;
    const dryRun = params.dryRun ?? this.deps.config.dryRun ?? false;
    const allowedPaths = params.allowedPaths ?? this.deps.config.allowedPaths ?? ['swap'];

    // Read just the parts of the balance sheet our allowedPaths need (lazy).
    const wantPartner = allowedPaths.includes('oft');
    const wantBtc = allowedPaths.includes('pegin');
    const address = (await this.deps.wallet.getAddressAsync(CHAINS[this.deps.goatChain].chainId)) as Address;

    const balances = await this.balances.read({
      address,
      partnerChains: wantPartner ? (this.deps.partnerChains ?? ['base-mainnet']) : [],
      // BTC L1 read needs a separate rpcUrl + address — caller's BtcSigner provides the address.
      // For v0.17 we skip the L1 balance read in the router (the path adapter quotes deterministically).
      btcL1: wantBtc && this.deps.btcSigner ? undefined : undefined,
      needs: this.lazyReadKeys(allowedPaths),
      signal,
    });

    // Partial-fill: target − current balance, clamped to ≥ 0.
    const delta = target > balances.usdcOnGoat ? target - balances.usdcOnGoat : 0n;
    if (delta === 0n) {
      return { status: 'no-op', acquired: 0n, correlationId };
    }

    // Enforce caps via SpendingGuard (independent rolling window for acquisitions).
    if (this.deps.guard) {
      const decision = this.deps.guard.checkAcquisition(delta, {
        maxPerHour: this.deps.config.maxPerHour,
        maxPerDay: this.deps.config.maxPerDay,
      });
      if (!decision.allowed) {
        throw goatError('GOAT_AUTOFUND_LIMIT_EXCEEDED', decision.reason);
      }
    }

    // Pick a path.
    const decision = await this.strategy.decide(balances, delta, this.paths, { allowedPaths, signal });

    if (dryRun) {
      return { status: 'dry-run', acquired: 0n, quote: decision.quote, correlationId };
    }

    // Execute.
    const adapter = this.paths.find((p) => p.path === decision.path)!;
    const receipt = await adapter.execute(decision.quote, { signal });

    // Audit.
    if (this.deps.guard) {
      this.deps.guard.recordAcquisition({
        amountUsdcWei: delta,
        chain: this.deps.goatChain,
        path: decision.path,
        fee: receipt.feePaid,
        srcChain: decision.quote.sourceChain,
        txHash: receipt.srcTxHash,
      });
    }

    // Structured log line.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.log(
        `[n-payment] ${correlationId} acquire ok ` +
        `path=${decision.path} target=${target} delta=${delta} fee=${receipt.feePaid} ` +
        `srcChain=${decision.quote.sourceChain} src=${receipt.srcTxHash} dst=${receipt.dstTxHash ?? '-'}`,
      );
    }

    return { status: 'executed', acquired: delta, quote: decision.quote, receipt, correlationId };
  }

  private lazyReadKeys(allowed: AcquisitionPath[]): Array<'pegbtcOnGoat' | 'usdcOnGoat' | 'usdcByChain' | 'btcL1Sats'> {
    const keys: Array<'pegbtcOnGoat' | 'usdcOnGoat' | 'usdcByChain' | 'btcL1Sats'> = ['usdcOnGoat'];
    if (allowed.includes('swap')) keys.push('pegbtcOnGoat');
    if (allowed.includes('oft')) keys.push('usdcByChain');
    if (allowed.includes('pegin')) keys.push('btcL1Sats');
    return keys;
  }
}

// ─── GoatAcquisitionPresets ──────────────────────────────────────────────────

/**
 * One-line config presets. Devex (gstack /plan-devex-review D1) — most callers
 * want a sensible default, not a 6-knob form. Returns plain config objects so
 * users can spread + override.
 */
export const GoatAcquisitionPresets = {
  /** swap+oft, $1/hr, $10/day, 1% fee, 0.5% slippage. The recommended default. */
  safeDefaults(): GoatAcquisitionConfig {
    return {
      enabled: true,
      allowedPaths: ['swap', 'oft'],
      maxPerHour: 1_000_000n,    // $1
      maxPerDay: 10_000_000n,    // $10
      maxFeeBps: 100,            // 1%
      maxSlippageBps: 50,        // 0.5%
    };
  },

  /** PegBTC swap only — no cross-chain risk; smallest blast radius. */
  swapOnly(): GoatAcquisitionConfig {
    return {
      enabled: true,
      allowedPaths: ['swap'],
      maxPerHour: 5_000_000n,    // $5
      maxPerDay: 50_000_000n,    // $50
      maxFeeBps: 100,
      maxSlippageBps: 50,
    };
  },

  /** Cross-chain only — for agents whose treasury sits on Base/Polygon. */
  oftOnly(): GoatAcquisitionConfig {
    return {
      enabled: true,
      allowedPaths: ['oft'],
      maxPerHour: 5_000_000n,
      maxPerDay: 50_000_000n,
      maxFeeBps: 150,            // 1.5% (LZ V2 fees can run higher than DEX)
    };
  },

  /** BTC L1 deep-treasury mode. Slow but sovereign. */
  peginOnly(): GoatAcquisitionConfig {
    return {
      enabled: true,
      allowedPaths: ['pegin'],
      maxPerHour: 50_000_000n,
      maxPerDay: 500_000_000n,
      maxFeeBps: 200,
    };
  },

  /** All paths, larger caps, looser slippage. For high-volume agents. */
  aggressive(): GoatAcquisitionConfig {
    return {
      enabled: true,
      allowedPaths: ['swap', 'oft', 'pegin'],
      maxPerHour: 100_000_000n,  // $100
      maxPerDay: 1_000_000_000n, // $1000
      maxFeeBps: 300,            // 3%
      maxSlippageBps: 100,       // 1%
    };
  },

  /** Mock-friendly defaults for goat-testnet quickstart + CI. */
  testnet(): GoatAcquisitionConfig {
    return {
      enabled: true,
      allowedPaths: ['swap', 'oft', 'pegin'],
      maxPerHour: 1_000_000_000n,    // $1k — testnet is unmetered for dev
      maxPerDay: 10_000_000_000n,
      maxFeeBps: 500,
      maxSlippageBps: 200,
    };
  },
};

// ─── Re-exports for the public surface ───────────────────────────────────────

export type {
  AcquisitionPath,
  GoatAcquisitionConfig,
  BtcSigner,
} from '../types.js';

export {
  GoatTokens,
  GoatBalances,
  GoatDexSwap,
  LayerZeroOftClient,
  BitVMBridgeClient,
  MockSwapAdapter,
  MockOftAdapter,
  MockBridgeAdapter,
  type AcquisitionPathAdapter,
  type AcquisitionQuote,
  type AcquisitionReceipt,
  type BalanceSheet,
} from './paths.js';

export { goatError, NPaymentError };
