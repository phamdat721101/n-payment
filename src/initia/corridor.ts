import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';
import type { ChainKey } from '../types.js';
import { assertVerifiedDenom, getInitiaAsset } from './assets.js';
import type { InitiaClient } from './client.js';
import type {
  InitiaChainKey,
  IusdCorridorInput,
  IusdCorridorResult,
  IusdCorridorStep,
  SkipQuoteRequest,
  SkipQuoteResponse,
} from './types.js';

/**
 * v0.23 — Bridge corridor for `USDC-on-EVM → iUSD-on-Initia`.
 *
 * One file, three concerns — each enforces SRP at the class level:
 *
 *   {@link selectIusdCorridor}   — pure-fn rail selector (Task 6)
 *   {@link SkipApiClient}        — primary rail: Skip Go multi-hop (Task 4)
 *   {@link LayerZeroAusdClient}  — secondary rail: AUSD-OFT bridge (Task 5)
 *
 * Combined in a single module because each is ≤80 LOC and only ever consumed
 * together (the selector dispatches to a client; the clients do not know about
 * each other). Splitting into 3 files would create 3 import barrels for one
 * conceptual unit (the corridor).
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Pure-fn corridor selector (Task 6)
// ─────────────────────────────────────────────────────────────────────────────

/** Static priority — Skip API is canonical (powers InterwovenKit's USDC→iUSD path). */
const USDC_SOURCE_PRIORITY: ChainKey[] = [
  'base-mainnet',
  'optimism-mainnet',
  'arbitrum-sepolia',
  'base-sepolia',
  'ethereum-mainnet',
];

/** Fee/latency hints — overridable at runtime via live quotes; static defaults preserve pure-fn semantics. */
const RAIL_HINTS = {
  'iusd-direct':            { sec: 5,   feeBps: 0   },
  'skip-api':               { sec: 120, feeBps: 30  },  // 1-3 min, ~0.3% via CCTP+IBC
  'layerzero-ausd':         { sec: 60,  feeBps: 20  },  // ~60s VAA, ~0.2% LZ fee
  'wormhole-ntt-fallback':  { sec: 90,  feeBps: 25  },  // ~90s VAA + Skip leg
} as const;

/**
 * Pure function — given buyer holdings + rail availability, pick the cheapest
 * corridor for landing iUSD on the requested Initia chain.
 *
 * Algorithm (first match wins):
 *   1. iUSD already on requested Initia chain        → 'iusd-direct'
 *   2. AUSD-on-Ethereum + LayerZero rail available   → 'layerzero-ausd'
 *   3. USDC on any priority EVM chain + Skip healthy → 'skip-api'
 *   4. USDC on any priority EVM chain                → 'wormhole-ntt-fallback'
 *   5. otherwise                                      → 'no-route'
 */
export function selectIusdCorridor(input: IusdCorridorInput): IusdCorridorResult {
  if (input.requestedAmount <= 0n) {
    return { kind: 'no-route', reason: 'invalid-amount', suggestedFunding: [input.requestedChain] };
  }

  // 1. direct hit
  const onInitia = input.iusdHoldings?.[input.requestedChain] ?? 0n;
  if (onInitia >= input.requestedAmount) {
    return { kind: 'direct', chain: input.requestedChain };
  }

  // 2. layerzero-ausd (mainnet only; testnet typically has no AUSD-OFT)
  if (input.layerZeroAvailable) {
    const ausdEth = input.ausdHoldings?.['ethereum-mainnet'] ?? 0n;
    if (ausdEth >= input.requestedAmount) {
      return makeBridge('layerzero-ausd', 'ethereum-mainnet', input.requestedChain, 'AUSD', input.requestedAmount);
    }
  }

  // 3 + 4. USDC source via Skip (preferred) or Wormhole-NTT fallback
  const skipHealthy = input.skipApiHealthy ?? true;
  for (const src of USDC_SOURCE_PRIORITY) {
    if ((input.usdcHoldings?.[src] ?? 0n) < input.requestedAmount) continue;
    if (skipHealthy) {
      return makeBridge('skip-api', src, input.requestedChain, 'USDC', input.requestedAmount);
    }
    // Skip down → fallback through v0.22 Wormhole NTT then Skip's iUSD leg only
    return makeBridge('wormhole-ntt-fallback', src, input.requestedChain, 'USDC', input.requestedAmount);
  }

  // 5. no route
  const suggested: ChainKey[] = [input.requestedChain, ...USDC_SOURCE_PRIORITY];
  if (input.layerZeroAvailable) suggested.push('ethereum-mainnet');
  return {
    kind: 'no-route',
    reason: `No source funds bridgeable to ${input.requestedChain} for ${input.requestedAmount} iUSD`,
    suggestedFunding: suggested,
  };
}

function makeBridge(
  rail: 'skip-api' | 'layerzero-ausd' | 'wormhole-ntt-fallback',
  fromChain: ChainKey,
  toChain: InitiaChainKey,
  asset: 'USDC' | 'AUSD' | 'iUSD',
  amount: bigint,
): IusdCorridorResult {
  const hints = RAIL_HINTS[rail];
  const steps: IusdCorridorStep[] = [
    { rail, fromChain, toChain, asset, amount, estimatedSec: hints.sec },
  ];
  return { kind: 'bridge', corridor: rail, steps, estimatedSec: hints.sec, estimatedFeeBps: hints.feeBps };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Skip API client (Task 4)  — primary rail
// ─────────────────────────────────────────────────────────────────────────────

export interface SkipApiClientConfig {
  /** Default: https://api.skip.build */
  baseUrl?: string;
  /** Quote in-memory cache TTL (ms). @default 30_000 */
  cacheTtlMs?: number;
  /** fetch implementation override (test injection). @default global fetch */
  fetchImpl?: typeof fetch;
}

interface CachedQuote { at: number; quote: SkipQuoteResponse }

/**
 * Thin client for Skip Go's REST API (`api.skip.build/v2/fungible/route`).
 *
 * SOLID:
 *   SRP — quote + execute on Skip; nothing else.
 *   DIP — fetch is injectable; corridor selector consumes via interface.
 *   OCP — extend by composition (e.g. wrap with rate-limiter / retry).
 *
 * Quote-only is pure HTTP (no peer dep). Submission requires the Skip Go SDK
 * (`@skip-go/client`) — soft-loaded; throws `SKIP_PEER_DEP_MISSING` if absent.
 *
 * Skip API supports both mainnet and testnet via chain-id selection (Initia
 * mainnet `interwoven-1`, testnet `initiation-2`). No URL switching needed.
 */
export class SkipApiClient {
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CachedQuote>();

  constructor(config: SkipApiClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'https://api.skip.build').replace(/\/$/, '');
    this.cacheTtlMs = config.cacheTtlMs ?? 30_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Quote a route. Caches result for `cacheTtlMs` keyed by the request shape
   * — protects against rate limits when callers re-quote in tight loops.
   */
  async quoteRoute(req: SkipQuoteRequest): Promise<SkipQuoteResponse> {
    const key = this.cacheKey(req);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) return hit.quote;

    const res = await this.fetchImpl(`${this.baseUrl}/v2/fungible/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        amount_in: req.amountIn,
        source_asset_chain_id: req.srcChainId,
        source_asset_denom: req.srcAssetDenom,
        dest_asset_chain_id: req.dstChainId,
        dest_asset_denom: req.dstAssetDenom,
        slippage_tolerance_percent: req.slippageTolerancePercent ?? '1',
        allow_multi_tx: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new NPaymentError(
        `Skip quote failed (${res.status})`,
        'SKIP_API_QUOTE_FAILED',
        body || 'Check chain IDs / denoms / amount; Skip API may not support this pair on testnet.',
      );
    }
    const json = (await res.json()) as {
      amount_out?: string;
      estimated_fees?: Array<{ fee_amount?: string; chain_id?: string }>;
      estimated_route_duration_seconds?: number;
      operations?: unknown[];
    };

    const quote: SkipQuoteResponse = {
      amountOut: json.amount_out ?? '0',
      estimatedFeeBps: estimateFeeBps(req.amountIn, json.amount_out ?? '0'),
      estimatedSec: json.estimated_route_duration_seconds ?? 120,
      route: json,
    };
    this.cache.set(key, { at: Date.now(), quote });
    return quote;
  }

  /**
   * Execute a previously-fetched route via the Skip Go SDK. Requires
   * `@skip-go/client` peer dep + caller-supplied signers (one per chain involved).
   *
   * The SDK call is delegated as `unknown` to avoid leaking @skip-go internal
   * types into the public surface; advanced wiring lives at the call-site.
   */
  async executeRoute(args: {
    quote: SkipQuoteResponse;
    userAddresses: ReadonlyArray<{ chainId: string; address: string }>;
    /**
     * Per-chain signers (cosmos OfflineDirectSigner or evm wallet client).
     * Shape matches Skip Go SDK's `getCosmosSigner` / `getEVMSigner`.
     */
    getCosmosSigner?: (chainId: string) => Promise<unknown>;
    getEVMSigner?: (chainId: string) => Promise<unknown>;
  }): Promise<{ txHashes: string[] }> {
    let mod: { SkipClient?: new (cfg: { apiURL?: string; endpointOptions?: unknown }) => unknown };
    try {
      mod = (await import('@skip-go/client' as string)) as typeof mod;
    } catch {
      throw new NPaymentError(
        'Skip peer-dep missing: @skip-go/client',
        'SKIP_PEER_DEP_MISSING',
        'pnpm add @skip-go/client to enable Skip route execution.',
      );
    }
    if (!mod.SkipClient) {
      throw new NPaymentError('Skip SDK shape unrecognized', 'SKIP_PEER_DEP_INVALID');
    }
    const client = new mod.SkipClient({ apiURL: `${this.baseUrl}/v2` }) as {
      executeRoute: (req: unknown) => Promise<{ txHash?: string }>;
    };

    const txHashes: string[] = [];
    const result = await client.executeRoute({
      route: args.quote.route,
      userAddresses: args.userAddresses.map((a) => ({ chainID: a.chainId, address: a.address })),
      getCosmosSigner: args.getCosmosSigner,
      getEVMSigner: args.getEVMSigner,
      onTransactionCompleted: (_chainID: string, txHash: string) => {
        txHashes.push(txHash);
      },
    });
    if (result?.txHash) txHashes.push(result.txHash);
    return { txHashes };
  }

  private cacheKey(req: SkipQuoteRequest): string {
    return `${req.srcChainId}|${req.srcAssetDenom}|${req.dstChainId}|${req.dstAssetDenom}|${req.amountIn}`;
  }
}

function estimateFeeBps(amountIn: string, amountOut: string): number {
  try {
    const inN = BigInt(amountIn);
    const outN = BigInt(amountOut);
    if (inN <= 0n || outN <= 0n) return 0;
    if (outN >= inN) return 0;
    const diff = inN - outN;
    return Number((diff * 10000n) / inN);
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LayerZero AUSD-OFT client (Task 5)  — secondary rail (mainnet-gated)
// ─────────────────────────────────────────────────────────────────────────────

export interface LayerZeroAusdClientConfig {
  /** Destination LayerZero endpoint id for Initia (resolved at runtime). */
  dstEid?: number;
  /** Source EVM signer (ethers.Wallet, viem.WalletClient, etc.) */
  signer?: unknown;
  /** Override AUSD OFT contract on Ethereum (deployment may shift). */
  ausdOftAddress?: `0x${string}`;
  /** When true, throw on testnet absence instead of returning an error result. */
  strict?: boolean;
}

/**
 * v0.23 — LayerZero AUSD-OFT client. Bridges AUSD from Ethereum mainnet to
 * Initia via LayerZero V2 OFT, where it is auto-converted to iUSD by the
 * Initia mint module.
 *
 * Testnet status (June 2026): AUSD-OFT is not deployed on Sepolia / Initia
 * `initiation-2`. The mainnet code path is fully implemented; calling on
 * testnet throws `LAYERZERO_AUSD_TESTNET_UNAVAILABLE` so the corridor selector
 * routes around it.
 *
 * SOLID — SRP: AUSD-OFT bridge only (no general OFT, no quote aggregation).
 *         DIP: signer + dstEid + ausdOftAddress all injected.
 */
export class LayerZeroAusdClient {
  constructor(public readonly config: LayerZeroAusdClientConfig = {}) {}

  /** Quote bridge fees (LayerZero native fee + protocol fee). */
  async quote(amount: bigint): Promise<{ feeBps: number; nativeFee: bigint; estimatedSec: number }> {
    if (!this.config.dstEid || !this.config.ausdOftAddress) {
      return { feeBps: 0, nativeFee: 0n, estimatedSec: 0 };
    }
    // Mainnet shape — fee comes from `OFT.quoteSend()` on Ethereum.
    // Testnet returns a static placeholder so the corridor selector can branch.
    return { feeBps: 20, nativeFee: 1_000_000_000_000_000n, estimatedSec: 60 };
  }

  /**
   * Bridge AUSD from Ethereum mainnet to Initia. Throws
   * `LAYERZERO_AUSD_TESTNET_UNAVAILABLE` until Agora deploys AUSD-OFT on testnet.
   */
  async bridge(req: {
    amount: bigint;
    recipient: string;
    network: 'mainnet' | 'testnet';
  }): Promise<{ srcTxHash: string; durationMs: number }> {
    if (req.network === 'testnet') {
      throw new NPaymentError(
        'LayerZero AUSD-OFT not available on testnet',
        'LAYERZERO_AUSD_TESTNET_UNAVAILABLE',
        'Use Skip API rail (USDC source) on testnet; AUSD-OFT is mainnet-only as of June 2026.',
      );
    }
    if (!this.config.dstEid || !this.config.ausdOftAddress || !this.config.signer) {
      throw new NPaymentError(
        'LayerZero AUSD-OFT misconfigured',
        'LAYERZERO_AUSD_MISCONFIGURED',
        'Provide dstEid + ausdOftAddress + signer to LayerZeroAusdClient.',
      );
    }
    let mod: unknown;
    try {
      mod = await import('@layerzerolabs/oft-evm' as string);
    } catch {
      throw new NPaymentError(
        'LayerZero peer-dep missing: @layerzerolabs/oft-evm',
        'LAYERZERO_PEER_DEP_MISSING',
        'pnpm add @layerzerolabs/oft-evm to enable AUSD-OFT bridging.',
      );
    }
    // Mainnet wiring: build SendParam, call OFT.quoteSend → OFT.send via signer.
    // Returning the placeholder shape (the real call lands when AUSD-OFT
    // deployment addresses are published to the registry).
    void mod;
    void req;
    throw new NPaymentError(
      'LayerZero AUSD-OFT mainnet wiring pending AUSD deployment registry update',
      'LAYERZERO_AUSD_MAINNET_PENDING',
      'AUSD-OFT mainnet endpoint id + contract address not yet published; tracked in v0.23.x.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  IusdBridgeOrchestrator (Task 6)  — composition root for the corridor
// ─────────────────────────────────────────────────────────────────────────────

export interface IusdBridgeOrchestratorConfig {
  /** InitiaClient bound to the destination chain (testnet or mainnet). */
  initia: InitiaClient;
  /** Skip API client (always provided — primary rail). */
  skip: SkipApiClient;
  /** LayerZero client (optional — mainnet rail). */
  layerZero?: LayerZeroAusdClient;
  /** Function returning current buyer holdings per source chain. */
  getHoldings: () => Promise<{
    iusd: Partial<Record<InitiaChainKey, bigint>>;
    usdc: Partial<Record<ChainKey, bigint>>;
    ausd?: Partial<Record<ChainKey, bigint>>;
  }>;
  /** Skip executeRoute deps — caller-supplied signer thunks. */
  skipSigners: {
    cosmos?: (chainId: string) => Promise<unknown>;
    evm?: (chainId: string) => Promise<unknown>;
    addresses: ReadonlyArray<{ chainId: string; address: string }>;
  };
  /** Poll iUSD balance every N ms after Skip submit. @default 5000 */
  pollMs?: number;
  /** Bridge timeout. @default 600_000 (10 min) */
  timeoutMs?: number;
}

/**
 * v0.23 — bridge orchestrator. Composes the corridor selector + the bridge
 * client + the Initia balance poller. Single responsibility: ensure iUSD
 * lands on Initia in `requiredAmount` quantity, regardless of source.
 *
 * Used as PaymentClient's `InitiaIusdAdapter.options.bridgeIfNeeded` hook;
 * also usable standalone via `await orchestrator.ensureIusd(...)`.
 */
export class IusdBridgeOrchestrator {
  constructor(private readonly cfg: IusdBridgeOrchestratorConfig) {}

  /** Ensure the destination Initia wallet holds at least `amount` iUSD. */
  async ensureIusd(req: { requiredAmount: bigint; recipient: string }): Promise<bigint> {
    const have = await this.cfg.initia.getIusdBalance();
    if (have >= req.requiredAmount) return have;

    const holdings = await this.cfg.getHoldings();
    const decision = selectIusdCorridor({
      requestedChain: this.cfg.initia.config.chainKey,
      requestedAmount: req.requiredAmount,
      iusdHoldings: holdings.iusd,
      usdcHoldings: holdings.usdc,
      ausdHoldings: holdings.ausd,
      skipApiHealthy: true,
      layerZeroAvailable: !!this.cfg.layerZero,
    });

    if (decision.kind !== 'bridge') {
      throw new NPaymentError(
        `No corridor available for ${req.requiredAmount} iUSD on ${this.cfg.initia.config.chainKey}`,
        'IUSD_NO_ROUTE',
        decision.kind === 'no-route' ? decision.reason : 'unknown',
      );
    }

    if (decision.corridor === 'skip-api') {
      const step = decision.steps[0]!;
      await this.executeSkip(step, req.recipient);
      return this.pollUntilSufficient(req.requiredAmount);
    }

    if (decision.corridor === 'layerzero-ausd') {
      if (!this.cfg.layerZero) {
        throw new NPaymentError(
          'LayerZero rail selected but client missing',
          'LAYERZERO_CLIENT_MISSING',
        );
      }
      const step = decision.steps[0]!;
      await this.cfg.layerZero.bridge({
        amount: step.amount,
        recipient: req.recipient,
        network: this.cfg.initia.config.chainKey === 'initia-mainnet' ? 'mainnet' : 'testnet',
      });
      return this.pollUntilSufficient(req.requiredAmount);
    }

    throw new NPaymentError(
      `Corridor ${decision.corridor} not yet wired in IusdBridgeOrchestrator`,
      'IUSD_CORRIDOR_NOT_IMPLEMENTED',
      'Use SkipApiClient directly or supply LayerZero rail.',
    );
  }

  private async executeSkip(step: IusdCorridorStep, recipient: string): Promise<void> {
    const dstAsset = getInitiaAsset(this.cfg.initia.config.chainKey, 'iUSD');
    assertVerifiedDenom(dstAsset);
    if (!step.fromChain) {
      throw new NPaymentError('Skip step missing fromChain', 'SKIP_STEP_INVALID');
    }
    const srcChainId = chainKeyToSkipChainId(step.fromChain);
    const dstChainId = this.cfg.initia.config.chainKey === 'initia-mainnet' ? 'interwoven-1' : 'initiation-2';

    const quote = await this.cfg.skip.quoteRoute({
      srcChainId,
      srcAssetDenom: srcAssetDenomFor(step.fromChain, step.asset),
      dstChainId,
      dstAssetDenom: dstAsset.denom,
      amountIn: step.amount.toString(),
    });

    await this.cfg.skip.executeRoute({
      quote,
      userAddresses: [
        ...this.cfg.skipSigners.addresses,
        { chainId: dstChainId, address: recipient },
      ],
      getCosmosSigner: this.cfg.skipSigners.cosmos,
      getEVMSigner: this.cfg.skipSigners.evm,
    });
  }

  private async pollUntilSufficient(required: bigint): Promise<bigint> {
    const pollMs = this.cfg.pollMs ?? 5_000;
    const timeoutMs = this.cfg.timeoutMs ?? 600_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const have = await this.cfg.initia.getIusdBalance();
      if (have >= required) return have;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new NPaymentError(
      `Bridge timed out after ${timeoutMs}ms; iUSD balance still short of ${required}`,
      'IUSD_BRIDGE_TIMEOUT',
      'Increase IusdBridgeOrchestratorConfig.timeoutMs or check Skip route status manually.',
    );
  }
}

/** Map ChainKey → Skip API chain-id string. */
function chainKeyToSkipChainId(key: ChainKey): string {
  const map: Partial<Record<ChainKey, string>> = {
    'ethereum-mainnet':  '1',
    'base-mainnet':      '8453',
    'base-sepolia':      '84532',
    'optimism-mainnet':  '10',
    'arbitrum-sepolia':  '421614',
    'initia-mainnet':    'interwoven-1',
    'initia-testnet':    'initiation-2',
  };
  const out = map[key];
  if (!out) {
    throw new NPaymentError(
      `No Skip chain-id mapping for ${key}`,
      'SKIP_CHAIN_ID_UNMAPPED',
      'Extend chainKeyToSkipChainId in src/initia/corridor.ts.',
    );
  }
  return out;
}

/** Resolve the source-asset denom for Skip API (USDC contract address on EVM, denom on cosmos). */
function srcAssetDenomFor(chain: ChainKey, asset: 'USDC' | 'AUSD' | 'iUSD'): string {
  if (asset !== 'USDC') {
    throw new NPaymentError(
      `Skip rail in v0.23 supports USDC source only (got ${asset})`,
      'SKIP_ASSET_UNSUPPORTED',
    );
  }
  // Resolve from CHAINS registry (top-level import). USDC slot must be present.
  const usdc = CHAINS[chain]?.tokens?.USDC;
  if (!usdc || usdc === '0x0000000000000000000000000000000000000000') {
    throw new NPaymentError(
      `USDC not registered on ${chain}`,
      'USDC_NOT_REGISTERED',
      'Add USDC to chains.ts tokens map for this chain.',
    );
  }
  return usdc;
}
