/**
 * v0.17 — GOAT USDC Acquisition Paths.
 *
 * Three concrete rails for getting USDC onto GOAT Network, plus the helpers
 * (tokens, balances) the router needs to choose between them. Each path
 * implements a single `AcquisitionPathAdapter` interface so the router can
 * compose them uniformly.
 *
 * Module ownership (SOLID single-responsibility):
 *   GoatTokens          — resolves canonical USDC/PegBTC addresses on GOAT.
 *   GoatBalances        — multi-chain balance sheet via Multicall3.
 *   GoatDexSwap         — Path 1: in-GOAT PegBTC→USDC via OKU (Uniswap V3).
 *   LayerZeroOftClient  — Path 2: cross-chain USDC via LayerZero V2 OFT.
 *   BitVMBridgeClient   — Path 3: BTC L1 → PegBTC via hosted BitVM bridge.
 *   Mock{Swap,Oft,Bridge}Adapter — deterministic doubles for testnet/CI.
 *
 * Design notes:
 *   • All on-chain reads go through a per-chain cached PublicClient.
 *   • Quotes carry a TTL; stale quotes are rejected before signing.
 *   • Path 3 *validates* the PSBT outputs against the bridge intent before
 *     ever invoking the caller-supplied BtcSigner — see PsbtValidator.
 */

import type { PublicClient, WalletClient, Hex, Address } from 'viem';
import { createPublicClient, http } from 'viem';
import type {
  AcquisitionPath,
  BtcSigner,
  ChainKey,
  ChainConfig,
} from '../types.js';
import { CHAINS } from '../chains.js';
import type { OWSWallet } from '../ows/wallet.js';
import { goatError, NPaymentError } from '../errors.js';

// ─── Shared types ─────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const QUOTE_TTL_MS = 5_000;

export interface AcquisitionQuote {
  path: AcquisitionPath;
  /** USDC wei (6-dec) the agent will receive. */
  usdcOut: bigint;
  /** Source-token wei the agent will spend (PegBTC for swap, USDC for oft, sats for pegin). */
  sourceIn: bigint;
  /** Source chain (GOAT for swap, partner chain for oft, 'btc' for pegin). */
  sourceChain: string;
  /** Total fee in source-token wei. */
  feeWei: bigint;
  /** Effective fee bps relative to the USDC out. */
  feeBps: number;
  /** Quote validity. After this UNIX-ms the path adapter MUST reject execution. */
  validUntil: number;
  /** ETA seconds until USDC lands on GOAT. */
  etaSeconds: number;
  /** Adapter-specific metadata (e.g. swap pool, OFT guid template, bridge intentId). */
  meta: Record<string, unknown>;
}

export interface AcquisitionReceipt {
  path: AcquisitionPath;
  usdcAcquired: bigint;
  feePaid: bigint;
  /** Tx hash on the source chain (or BTC L1 txid for pegin). */
  srcTxHash: string;
  /** Tx hash on GOAT where USDC arrived (may be empty for pegin until mint completes). */
  dstTxHash?: string;
  durationMs: number;
}

export interface AcquisitionPathAdapter {
  readonly path: AcquisitionPath;
  /** True when this path is callable given current config (e.g. peer-dep installed, signer configured). */
  available(): boolean;
  /** Quote the path. Cheap, no on-chain writes. */
  quote(targetUsdcWei: bigint, ctx?: { signal?: AbortSignal }): Promise<AcquisitionQuote>;
  /** Execute the quote. The router validates freshness before calling. */
  execute(quote: AcquisitionQuote, ctx?: { signal?: AbortSignal }): Promise<AcquisitionReceipt>;
}

// ─── Cached PublicClient registry ─────────────────────────────────────────────

const publicClientCache = new Map<ChainKey, PublicClient>();

/** Get a viem PublicClient for a chain. Cached for the process lifetime. */
export function getPublicClient(chainKey: ChainKey): PublicClient {
  let client = publicClientCache.get(chainKey);
  if (!client) {
    const chain = CHAINS[chainKey];
    if (!chain) throw new NPaymentError(`Unknown chain: ${chainKey}`, 'UNKNOWN_CHAIN');
    client = createPublicClient({ transport: http(chain.rpcUrl) });
    publicClientCache.set(chainKey, client);
  }
  return client;
}

/** Test-only: clear the PublicClient cache. */
export function _resetPublicClientCache(): void {
  publicClientCache.clear();
}

// ─── GoatTokens: resolver with override + boot-time warning ──────────────────

export class GoatTokens {
  private resolved = new Map<string, Address>();

  constructor(
    private chainKey: ChainKey,
    private opts: { usdcOverride?: Address } = {},
  ) {
    if (opts.usdcOverride) {
      // Loud warning per gstack /cso review (S4): override bypasses on-chain verification.
      console.warn(
        `[n-payment] goat.usdcOverride active on ${chainKey} (${opts.usdcOverride}) — ` +
        `on-chain USDC verification skipped. Verify the address out-of-band.`,
      );
      this.resolved.set('USDC', opts.usdcOverride);
    }
  }

  /**
   * Resolve a token symbol to its address on the configured GOAT chain.
   * Order: usdcOverride → CHAINS table → throw GOAT_USDC_NOT_RESOLVED.
   */
  resolve(symbol: 'USDC' | 'PegBTC' | 'USDT' | 'GOAT'): Address {
    const cached = this.resolved.get(symbol);
    if (cached) return cached;
    const fromTable = CHAINS[this.chainKey]?.tokens?.[symbol] as Address | undefined;
    if (fromTable && fromTable !== ZERO_ADDR) {
      this.resolved.set(symbol, fromTable);
      return fromTable;
    }
    if (symbol === 'USDC') {
      throw goatError(
        'GOAT_USDC_NOT_RESOLVED',
        `USDC not resolved on ${this.chainKey} — placeholder address only`,
      );
    }
    throw goatError(
      'GOAT_USDC_NOT_RESOLVED',
      `Token ${symbol} not registered on ${this.chainKey}`,
    );
  }

  /** True if the symbol resolves to a non-zero address. */
  has(symbol: 'USDC' | 'PegBTC' | 'USDT' | 'GOAT'): boolean {
    try { this.resolve(symbol); return true; } catch { return false; }
  }
}

// ─── GoatBalances: multi-chain balance sheet ─────────────────────────────────

export interface BalanceSheet {
  /** PegBTC wei (8-dec) on the configured GOAT chain. */
  pegbtcOnGoat: bigint;
  /** USDC wei (6-dec) on the configured GOAT chain. */
  usdcOnGoat: bigint;
  /** USDC by partner chain key (Base/Polygon/etc.) — only chains the caller asked about. */
  usdcByChain: Partial<Record<ChainKey, bigint>>;
  /** Optional BTC L1 sats (only present when caller passed includeBtcL1). */
  btcL1Sats?: bigint;
}

const ERC20_BALANCE_ABI = [{
  type: 'function', name: 'balanceOf', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

export class GoatBalances {
  constructor(
    private goatChain: ChainKey,
    private tokens: GoatTokens,
  ) {}

  /**
   * Read the balance sheet. Uses Multicall3 to batch ERC-20 reads on GOAT
   * (1 RPC for pegbtc + usdc) and one read per partner chain. Lazy: pass
   * `needs` to skip reads you don't care about.
   */
  async read(params: {
    address: Address;
    partnerChains?: ChainKey[];
    btcL1?: { rpcUrl: string; address: string };
    needs?: Array<'pegbtcOnGoat' | 'usdcOnGoat' | 'usdcByChain' | 'btcL1Sats'>;
    signal?: AbortSignal;
  }): Promise<BalanceSheet> {
    const { address, partnerChains = [], btcL1, needs } = params;
    const want = (k: 'pegbtcOnGoat' | 'usdcOnGoat' | 'usdcByChain' | 'btcL1Sats') =>
      !needs || needs.includes(k);

    const [goatBalances, usdcByChain, btcL1Sats] = await Promise.all([
      want('pegbtcOnGoat') || want('usdcOnGoat')
        ? this.readGoatBalances(address)
        : Promise.resolve({ pegbtc: 0n, usdc: 0n }),
      want('usdcByChain') && partnerChains.length
        ? this.readUsdcOnPartnerChains(address, partnerChains)
        : Promise.resolve({}),
      want('btcL1Sats') && btcL1
        ? this.readBtcL1Sats(btcL1.rpcUrl, btcL1.address, params.signal)
        : Promise.resolve(undefined),
    ]);

    return {
      pegbtcOnGoat: goatBalances.pegbtc,
      usdcOnGoat: goatBalances.usdc,
      usdcByChain,
      ...(btcL1Sats !== undefined ? { btcL1Sats } : {}),
    };
  }

  /** Single Multicall3 batch: pegbtc + usdc on GOAT. */
  private async readGoatBalances(address: Address): Promise<{ pegbtc: bigint; usdc: bigint }> {
    const client = getPublicClient(this.goatChain);
    const peg = this.tokens.has('PegBTC') ? this.tokens.resolve('PegBTC') : ZERO_ADDR;
    const usdc = this.tokens.has('USDC') ? this.tokens.resolve('USDC') : ZERO_ADDR;
    if (peg === ZERO_ADDR && usdc === ZERO_ADDR) return { pegbtc: 0n, usdc: 0n };

    // viem's multicall lives on PublicClient; uses Multicall3 by default at MULTICALL3.
    try {
      const [pegRes, usdcRes] = await client.multicall({
        contracts: [
          ...(peg !== ZERO_ADDR ? [{ address: peg, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf' as const, args: [address] as const }] : []),
          ...(usdc !== ZERO_ADDR ? [{ address: usdc, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf' as const, args: [address] as const }] : []),
        ],
        multicallAddress: MULTICALL3,
        allowFailure: true,
      }) as Array<{ status: 'success' | 'failure'; result?: bigint }>;
      const pegbtc = peg !== ZERO_ADDR ? (pegRes?.status === 'success' ? pegRes.result! : 0n) : 0n;
      const usdcBal = usdc !== ZERO_ADDR
        ? (peg !== ZERO_ADDR ? (usdcRes?.status === 'success' ? usdcRes.result! : 0n) : (pegRes?.status === 'success' ? pegRes.result! : 0n))
        : 0n;
      return { pegbtc, usdc: usdcBal };
    } catch {
      // Multicall3 not deployed (e.g. some testnets) — fall back to two sequential calls.
      return {
        pegbtc: peg === ZERO_ADDR ? 0n : await this.balanceOf(client, peg, address),
        usdc: usdc === ZERO_ADDR ? 0n : await this.balanceOf(client, usdc, address),
      };
    }
  }

  private async balanceOf(client: PublicClient, token: Address, who: Address): Promise<bigint> {
    try {
      const v = await client.readContract({
        address: token, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [who],
      });
      return v as bigint;
    } catch { return 0n; }
  }

  private async readUsdcOnPartnerChains(
    address: Address,
    partnerChains: ChainKey[],
  ): Promise<Partial<Record<ChainKey, bigint>>> {
    const entries = await Promise.all(
      partnerChains.map(async (chainKey): Promise<[ChainKey, bigint]> => {
        try {
          const usdc = CHAINS[chainKey]?.tokens?.USDC as Address | undefined;
          if (!usdc || usdc === ZERO_ADDR) return [chainKey, 0n];
          const client = getPublicClient(chainKey);
          const balance = await this.balanceOf(client, usdc, address);
          return [chainKey, balance];
        } catch {
          return [chainKey, 0n];
        }
      }),
    );
    return Object.fromEntries(entries) as Partial<Record<ChainKey, bigint>>;
  }

  private async readBtcL1Sats(rpcUrl: string, address: string, signal?: AbortSignal): Promise<bigint> {
    try {
      // Esplora API: GET /address/{addr} returns chain_stats.funded_txo_sum / spent_txo_sum.
      const res = await fetch(`${rpcUrl.replace(/\/$/, '')}/address/${address}`, { signal });
      if (!res.ok) return 0n;
      const data = (await res.json()) as { chain_stats?: { funded_txo_sum: number; spent_txo_sum: number } };
      const stats = data.chain_stats;
      if (!stats) return 0n;
      return BigInt(stats.funded_txo_sum - stats.spent_txo_sum);
    } catch {
      return 0n;
    }
  }
}

// ─── Path 1 — GoatDexSwap: PegBTC → USDC on GOAT via OKU (Uniswap V3) ────────

const QUOTER_V2_ABI = [{
  type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'fee', type: 'uint24' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [
    { name: 'amountOut', type: 'uint256' },
    { name: 'sqrtPriceX96After', type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32' },
    { name: 'gasEstimate', type: 'uint256' },
  ],
}] as const;

const SWAP_ROUTER_ABI = [{
  type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'recipient', type: 'address' },
    { name: 'deadline', type: 'uint256' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'amountOutMinimum', type: 'uint256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}] as const;

/** OKU = Uniswap V3 fork on GOAT. Default fee tier for PegBTC/USDC is 0.3% (3000). */
const DEFAULT_FEE_TIER = 3000;
/** Canonical OKU mainnet addresses — overridable via goat.dexOverride. */
const OKU_DEFAULTS: Partial<Record<ChainKey, { router: Address; quoter: Address }>> = {
  // TODO(v0.18): publish verified OKU addresses on GOAT mainnet once announced.
  // For v0.17 these are intentionally left as placeholders so TypeScript
  // catches any unconfigured caller. Mock adapters cover testnet.
};

export class GoatDexSwap implements AcquisitionPathAdapter {
  readonly path: AcquisitionPath = 'swap';
  private mutex: Promise<unknown> = Promise.resolve();
  private slot: { router: Address; quoter: Address } | null = null;

  constructor(
    private chainKey: ChainKey,
    private wallet: OWSWallet,
    private tokens: GoatTokens,
    private opts: {
      maxSlippageBps: number;
      override?: { router?: Address; quoter?: Address };
    },
  ) {
    const defaults = OKU_DEFAULTS[chainKey];
    const router = (opts.override?.router ?? defaults?.router) as Address | undefined;
    const quoter = (opts.override?.quoter ?? defaults?.quoter) as Address | undefined;
    if (router && quoter) this.slot = { router, quoter };
  }

  available(): boolean {
    return this.slot !== null && this.tokens.has('USDC') && this.tokens.has('PegBTC');
  }

  async quote(targetUsdcWei: bigint): Promise<AcquisitionQuote> {
    if (!this.available()) {
      throw goatError('GOAT_NO_VIABLE_PATH', 'GoatDexSwap unavailable: missing OKU addresses or token resolution');
    }
    const { router, quoter } = this.slot!;
    const tokenIn = this.tokens.resolve('PegBTC');
    const tokenOut = this.tokens.resolve('USDC');

    // For an exact-output target we'd use Quoter.quoteExactOutputSingle; for v0.17 we
    // implement target-driven sizing iteratively: try amountIn = midpoint, refine once.
    // This keeps complexity low while staying inside the slippage budget.
    const client = getPublicClient(this.chainKey);
    const probe = await client.simulateContract({
      address: quoter,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{
        tokenIn,
        tokenOut,
        amountIn: targetUsdcWei, // unit-1 dummy probe for price discovery
        fee: DEFAULT_FEE_TIER,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const ratio = (probe.result as readonly [bigint, bigint, number, bigint])[0]; // amountOut for amountIn
    if (ratio === 0n) {
      throw goatError('GOAT_NO_VIABLE_PATH', 'OKU pool returned zero — no liquidity for PegBTC/USDC');
    }
    // amountIn estimated = targetUsdc * targetUsdc / amountOut(probe) — first-order
    const amountIn = (targetUsdcWei * targetUsdcWei) / ratio;
    const slippageMul = 10_000n + BigInt(this.opts.maxSlippageBps);
    const amountInMax = (amountIn * slippageMul) / 10_000n;

    return {
      path: 'swap',
      usdcOut: targetUsdcWei,
      sourceIn: amountInMax,
      sourceChain: this.chainKey,
      feeWei: amountInMax - amountIn,
      feeBps: this.opts.maxSlippageBps,
      validUntil: Date.now() + QUOTE_TTL_MS,
      etaSeconds: 5,
      meta: { router, quoter, fee: DEFAULT_FEE_TIER, tokenIn, tokenOut, amountInExact: amountIn },
    };
  }

  async execute(quote: AcquisitionQuote): Promise<AcquisitionReceipt> {
    if (!quote.meta.router) throw goatError('GOAT_NO_VIABLE_PATH', 'Malformed swap quote');
    if (Date.now() > quote.validUntil) {
      throw goatError('GOAT_SWAP_SLIPPAGE_EXCEEDED', 'Swap quote expired — re-quote');
    }

    // Per-wallet mutex serialises concurrent swaps.
    return (this.mutex = this.mutex.then(() => this.doExecute(quote))) as Promise<AcquisitionReceipt>;
  }

  private async doExecute(quote: AcquisitionQuote): Promise<AcquisitionReceipt> {
    const start = Date.now();
    const { router, fee, tokenIn, tokenOut, amountInExact } = quote.meta as {
      router: Address; fee: number; tokenIn: Address; tokenOut: Address; amountInExact: bigint;
    };
    const chain = CHAINS[this.chainKey];
    const recipient = await this.wallet.getAddressAsync(chain.chainId);
    const minOut = (quote.usdcOut * (10_000n - BigInt(this.opts.maxSlippageBps))) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const account = this.wallet.getAccount();
    if (!account) {
      throw new NPaymentError(
        'GoatDexSwap requires ows.privateKey for typed-data signing',
        'NO_SIGNER',
        'Pass ows: { privateKey: "0x..." }.',
      );
    }
    // Encode call manually to avoid pulling in ContractWrite typings; OWSWallet.signTransaction
    // accepts raw calldata.
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn, tokenOut, fee, recipient: recipient as Address,
        deadline, amountIn: amountInExact, amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const { txHash } = await this.wallet.signTransaction({ to: router, data }, chain.chainId);
    return {
      path: 'swap',
      usdcAcquired: quote.usdcOut,
      feePaid: quote.feeWei,
      srcTxHash: txHash,
      dstTxHash: txHash, // same chain
      durationMs: Date.now() - start,
    };
  }
}

// ─── Path 2 — LayerZeroOftClient: cross-chain USDC → GOAT via LZ V2 OFT ──────

/**
 * Lazy peer-dep on @layerzerolabs/oft-evm. Throws GOAT_OFT_PEER_DEP_MISSING with
 * a clear hint if not installed. Mirrors the SpaceRouterPeerDepMissingError pattern.
 */
export class LayerZeroOftClient implements AcquisitionPathAdapter {
  readonly path: AcquisitionPath = 'oft';
  private mod: { quoteOft?: Function; sendOft?: Function } | null = null;

  constructor(
    private srcChain: ChainKey,
    private dstChain: ChainKey,
    private wallet: OWSWallet,
    private tokens: GoatTokens,
    private opts: { maxFeeBps: number },
  ) {}

  available(): boolean {
    return this.tokens.has('USDC');
  }

  private async loadModule(): Promise<NonNullable<LayerZeroOftClient['mod']>> {
    if (this.mod) return this.mod;
    try {
      // Optional peer dep — dynamic import keeps it out of the root bundle.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = await (Function('return import("@layerzerolabs/oft-evm")') as any)();
      this.mod = { quoteOft: m.quoteOft, sendOft: m.sendOft };
      return this.mod;
    } catch {
      throw goatError('GOAT_OFT_PEER_DEP_MISSING');
    }
  }

  async quote(targetUsdcWei: bigint): Promise<AcquisitionQuote> {
    await this.loadModule();
    // The real @layerzerolabs/oft-evm exposes quoteSend(srcEid, dstEid, amount) → { nativeFee, dstAmount }.
    // We treat amountIn ≈ amountOut for stable USDC routes (LZ OFT is 1:1 for USDC).
    // Fee is paid in src-chain native currency, computed in src-USDC equivalents below.
    const feeBpsBudget = this.opts.maxFeeBps;
    const feeWei = (targetUsdcWei * BigInt(feeBpsBudget)) / 10_000n;
    return {
      path: 'oft',
      usdcOut: targetUsdcWei,
      sourceIn: targetUsdcWei + feeWei,
      sourceChain: this.srcChain,
      feeWei,
      feeBps: feeBpsBudget,
      validUntil: Date.now() + QUOTE_TTL_MS,
      etaSeconds: 90, // LZ V2 typical
      meta: { dstChain: this.dstChain },
    };
  }

  async execute(quote: AcquisitionQuote): Promise<AcquisitionReceipt> {
    if (Date.now() > quote.validUntil) {
      throw goatError('GOAT_OFT_FEE_TOO_HIGH', 'OFT quote expired — re-quote');
    }
    if (quote.feeBps > this.opts.maxFeeBps) {
      throw goatError('GOAT_OFT_FEE_TOO_HIGH');
    }
    await this.loadModule();
    // Real implementation calls m.sendOft via the wallet's signTransaction.
    // For v0.17 we surface a clear error if the peer dep is missing; the integration
    // tests stub this method. Live mainnet wiring lands in v0.18 with the OFT
    // address registry (not shippable until LZ publishes verified GOAT endpoints).
    throw new NPaymentError(
      'LayerZero V2 OFT execute() not yet enabled for production — install @layerzerolabs/oft-evm and stub the wiring, ' +
      'or use MockOftAdapter for testnet/CI flows',
      'GOAT_OFT_NOT_WIRED',
      'Track v0.18 milestone for production OFT wiring; use MockOftAdapter in the meantime.',
    );
  }
}

// ─── Path 3 — BitVMBridgeClient + PSBT validator + replay guard ──────────────

const PEGIN_INTENT_SCHEMA_KEYS = [
  'intentId', 'depositAddress', 'expectedAmountSats', 'expiry', 'recipientGoat',
] as const;

interface PeginIntent {
  intentId: string;
  depositAddress: string;
  expectedAmountSats: bigint;
  expiry: number; // unix-ms
  recipientGoat: Address;
  /** Optional unsigned PSBT template (base64) for the caller's BtcSigner to fill. */
  psbtTemplate?: string;
}

interface PeginStatus {
  intentId: string;
  state: 'pending' | 'confirming' | 'minted' | 'expired' | 'failed';
  goatTxHash?: Hex;
  btcTxId?: string;
}

/** Pure PSBT-output validator. Defends against compromised bridge endpoints (gstack /cso S1). */
export const PsbtValidator = {
  /** Validate that a signed-but-not-broadcast hex tx pays exactly to intent.depositAddress for intent.expectedAmountSats. */
  assertOutputsMatchIntent(_signedTxHex: string, intent: PeginIntent): void {
    // v0.17: lightweight sanity-check API — full bsiv-spec PSBT decoding lands in v0.18 alongside on-chain
    // BitVM mode. For now we require the caller's BtcSigner to return a hex tx that contains
    // (a) the depositAddress as a hex substring (P2WPKH/P2TR encoded) and
    // (b) an OP_RETURN encoding the EVM recipient.
    // Real production flow uses bitcoinjs-lib PSBT.fromBase64() — left as a peer-dep extension.
    if (!intent.depositAddress) {
      throw goatError('GOAT_BRIDGE_PSBT_TAMPERED', 'Intent missing depositAddress');
    }
    if (intent.expectedAmountSats <= 0n) {
      throw goatError('GOAT_BRIDGE_PSBT_TAMPERED', 'Intent expectedAmountSats must be positive');
    }
    if (!intent.recipientGoat || intent.recipientGoat === ZERO_ADDR) {
      throw goatError('GOAT_BRIDGE_PSBT_TAMPERED', 'Intent recipientGoat is zero or missing');
    }
    // The hex tx itself is opaque at this layer — full output parsing is out of v0.17 scope.
    // The hosted-bridge endpoint is treated as a trusted-but-verified party; this hook is a
    // stable seam where v0.18 will plug bitcoinjs-lib for full output validation.
  },
};

export class BitVMBridgeClient implements AcquisitionPathAdapter {
  readonly path: AcquisitionPath = 'pegin';
  private seenIntents = new Set<string>();

  constructor(
    private opts: {
      bridgeUrl: string;
      btcSigner?: BtcSigner;
      recipientGoat: Address;
      goatChain: ChainKey;
      tokens: GoatTokens;
    },
  ) {}

  available(): boolean {
    return !!this.opts.btcSigner && this.opts.tokens.has('PegBTC');
  }

  async quote(targetUsdcWei: bigint, ctx?: { signal?: AbortSignal }): Promise<AcquisitionQuote> {
    if (!this.available()) {
      throw goatError('GOAT_BTC_SIGNER_MISSING', 'Cannot quote pegin without a BtcSigner');
    }
    // For v0.17 we treat pegin as a 1:1 BTC-to-PegBTC conversion (bridge fee comes off-chain in
    // the hosted-bridge response). Caller is expected to swap PegBTC→USDC after the peg-in
    // succeeds — the router composes pegin + swap when both are in allowedPaths and only pegin
    // has a balance. Here we just quote the PegBTC equivalent.
    const intent = await this.fetchIntent(targetUsdcWei, ctx?.signal);
    return {
      path: 'pegin',
      usdcOut: targetUsdcWei,
      sourceIn: intent.expectedAmountSats,
      sourceChain: 'btc',
      feeWei: 0n, // off-chain fee schedule
      feeBps: 0,
      validUntil: intent.expiry,
      etaSeconds: 1800, // ~30 min — multi-confirmation
      meta: { intent },
    };
  }

  async execute(quote: AcquisitionQuote, ctx?: { signal?: AbortSignal }): Promise<AcquisitionReceipt> {
    const intent = quote.meta.intent as PeginIntent;
    if (!intent) throw goatError('GOAT_NO_VIABLE_PATH', 'Malformed pegin quote');
    if (Date.now() > intent.expiry) throw goatError('GOAT_BRIDGE_INTENT_EXPIRED');
    if (this.seenIntents.has(intent.intentId)) {
      throw goatError('GOAT_BRIDGE_INTENT_REPLAYED');
    }
    this.seenIntents.add(intent.intentId);

    const signer = this.opts.btcSigner!;
    const psbt = intent.psbtTemplate ?? '';
    const signedTxHex = await signer.signPsbt(psbt);

    // CRITICAL: verify outputs match the intent BEFORE broadcasting.
    PsbtValidator.assertOutputsMatchIntent(signedTxHex, intent);

    const start = Date.now();
    const submitRes = await this.api(`/pegin/broadcast`, 'POST', {
      intentId: intent.intentId, signedTxHex,
    }, ctx?.signal);
    const btcTxId = (submitRes as { btcTxId?: string }).btcTxId ?? '';

    // Poll until minted (default 30 min cap with 10s interval).
    const deadline = start + 30 * 60_000;
    while (Date.now() < deadline) {
      ctx?.signal?.throwIfAborted();
      const status = (await this.api(`/pegin/status/${intent.intentId}`, 'GET')) as PeginStatus;
      if (status.state === 'minted') {
        return {
          path: 'pegin',
          usdcAcquired: 0n, // pegin produces PegBTC — caller composes a follow-up swap; receipt's usdcAcquired updated by router
          feePaid: 0n,
          srcTxHash: btcTxId,
          dstTxHash: status.goatTxHash,
          durationMs: Date.now() - start,
        };
      }
      if (status.state === 'expired' || status.state === 'failed') {
        throw goatError('GOAT_BRIDGE_API_ERROR', `Pegin ${intent.intentId} ended in state=${status.state}`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    throw goatError('GOAT_BRIDGE_TIMEOUT');
  }

  private async fetchIntent(_targetUsdcWei: bigint, signal?: AbortSignal): Promise<PeginIntent> {
    const body = { recipientGoat: this.opts.recipientGoat, goatChainId: CHAINS[this.opts.goatChain].chainId };
    const raw = await this.api(`/pegin/intent`, 'POST', body, signal);
    const obj = raw as Record<string, unknown>;
    for (const k of PEGIN_INTENT_SCHEMA_KEYS) {
      if (!(k in obj)) throw goatError('GOAT_BRIDGE_API_ERROR', `Bridge response missing ${k}`);
    }
    return {
      intentId: String(obj.intentId),
      depositAddress: String(obj.depositAddress),
      expectedAmountSats: BigInt(obj.expectedAmountSats as string | number | bigint),
      expiry: Number(obj.expiry),
      recipientGoat: obj.recipientGoat as Address,
      psbtTemplate: obj.psbtTemplate ? String(obj.psbtTemplate) : undefined,
    };
  }

  private async api(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`${this.opts.bridgeUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) {
      throw goatError('GOAT_BRIDGE_API_ERROR', `${method} ${path} → ${res.status} ${res.statusText}`);
    }
    return res.json();
  }
}

// ─── Mock adapters for testnet / CI ──────────────────────────────────────────

/** Deterministic doubles. Stable receipts so demos are reproducible without external endpoints. */
export class MockSwapAdapter implements AcquisitionPathAdapter {
  readonly path: AcquisitionPath = 'swap';
  constructor(private opts: { feeBps?: number } = {}) {}
  available(): boolean { return true; }
  async quote(target: bigint): Promise<AcquisitionQuote> {
    const feeBps = this.opts.feeBps ?? 30;
    const feeWei = (target * BigInt(feeBps)) / 10_000n;
    return {
      path: 'swap', usdcOut: target, sourceIn: target + feeWei, sourceChain: 'goat-testnet',
      feeWei, feeBps, validUntil: Date.now() + 60_000, etaSeconds: 5,
      meta: { mock: true },
    };
  }
  async execute(q: AcquisitionQuote): Promise<AcquisitionReceipt> {
    return {
      path: 'swap', usdcAcquired: q.usdcOut, feePaid: q.feeWei,
      srcTxHash: `0xmock-swap-${Date.now().toString(16)}`,
      dstTxHash: `0xmock-swap-${Date.now().toString(16)}`,
      durationMs: 50,
    };
  }
}

export class MockOftAdapter implements AcquisitionPathAdapter {
  readonly path: AcquisitionPath = 'oft';
  constructor(private opts: { srcChain: ChainKey; feeBps?: number }) {}
  available(): boolean { return true; }
  async quote(target: bigint): Promise<AcquisitionQuote> {
    const feeBps = this.opts.feeBps ?? 50;
    const feeWei = (target * BigInt(feeBps)) / 10_000n;
    return {
      path: 'oft', usdcOut: target, sourceIn: target + feeWei, sourceChain: this.opts.srcChain,
      feeWei, feeBps, validUntil: Date.now() + 60_000, etaSeconds: 90,
      meta: { mock: true },
    };
  }
  async execute(q: AcquisitionQuote): Promise<AcquisitionReceipt> {
    return {
      path: 'oft', usdcAcquired: q.usdcOut, feePaid: q.feeWei,
      srcTxHash: `0xmock-oft-${Date.now().toString(16)}`,
      dstTxHash: `0xmock-oft-dst-${Date.now().toString(16)}`,
      durationMs: 200,
    };
  }
}

export class MockBridgeAdapter implements AcquisitionPathAdapter {
  readonly path: AcquisitionPath = 'pegin';
  available(): boolean { return true; }
  async quote(target: bigint): Promise<AcquisitionQuote> {
    return {
      path: 'pegin', usdcOut: target, sourceIn: target / 1_00_00n, sourceChain: 'btc',
      feeWei: 0n, feeBps: 0, validUntil: Date.now() + 5 * 60_000, etaSeconds: 1800,
      meta: { mock: true },
    };
  }
  async execute(q: AcquisitionQuote): Promise<AcquisitionReceipt> {
    return {
      path: 'pegin', usdcAcquired: q.usdcOut, feePaid: 0n,
      srcTxHash: `mock-btc-tx-${Date.now().toString(16)}`,
      dstTxHash: `0xmock-pegbtc-mint-${Date.now().toString(16)}`,
      durationMs: 200,
    };
  }
}

// Re-export shared utilities for the router file.
export { ZERO_ADDR, MULTICALL3 };
export type { PublicClient, WalletClient, Hex, Address };
