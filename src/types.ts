// ─── Protocol & Chain ────────────────────────────────────────────────────────

export type ProtocolType = 'x402' | 'mpp' | 'xrpl' | 'stellar-x402' | 'stellar-mpp' | 'stellar-mpp-session' | 'morph-x402' | 'spacerouter' | 'flare-fxrp' | 'auto';

export type ChainKey =
  | 'base-sepolia'
  | 'arbitrum-sepolia'
  | 'goat-testnet'
  | 'goat-mainnet'
  | 'tempo-testnet'
  | 'tempo-mainnet'
  | 'base-mainnet'
  | 'bnb-mainnet'
  | 'bnb-testnet'
  | 'xrpl-testnet'
  | 'xrpl-mainnet'
  | 'stellar-testnet'
  | 'stellar-mainnet'
  | 'solana-mainnet'
  | 'solana-devnet'
  | 'morph-mainnet'
  | 'morph-hoodi-testnet'
  | 'creditcoin-mainnet'
  | 'creditcoin-testnet'
  | 'flare-coston2-testnet';

export interface ChainConfig {
  chainId: number;
  caip2: string;
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  protocols: string[];
  tokens: Record<string, string>;
  facilitator?: string;
}

// ─── XRPL ────────────────────────────────────────────────────────────────────

/**
 * XRPL agent configuration.
 *
 * v0.14 adds RLUSD-aware auto-swap (atomic XRP→RLUSD via cross-currency Payment)
 * and XLS-65 vault treasury yield-parity (mirroring v0.13 Aave config).
 */
export interface XrplConfig {
  /** XRPL secret seed (sEd...). Optional in OWS dual-mode. */
  seed?: string;
  /** Override rippled WS/RPC URL. Default: per-network public cluster. */
  server?: string;
  /** XRPL network. Determines RLUSD issuer + facilitator. @default 'testnet' */
  network?: 'testnet' | 'mainnet';

  // ── v0.14 auto-swap ─────────────────────────────────────────────────────
  /**
   * On a 402 RLUSD challenge with insufficient RLUSD balance, automatically
   * swap from XRP via XRPL native cross-currency Payment (AMM + DEX auto-routed
   * by rippled). @default false
   */
  autoSwap?: boolean;
  /** Max acceptable slippage on auto-swap, in basis points. @default 100 (1%) */
  maxSlippageBps?: number;
  /** Throw on missing seed/owsWallet instead of warning + disabling. @default false */
  strict?: boolean;
  /**
   * Minimum XRP drops the wallet must hold before XLS-65 VaultCreate can
   * be auto-provisioned (covers owner reserve). @default 5_000_000 (5 XRP)
   */
  minXrpReserve?: bigint;

  // ── v0.14 XLS-65 treasury ───────────────────────────────────────────────
  /** XLS-65 vault treasury (yield-parity with v0.13 Aave manager). Omit to disable. */
  treasury?: XrplTreasuryConfigInput;
}

/**
 * Public-shape of XRPL treasury config. The runtime adds a pluggable VaultIdStore;
 * this surface stays declarative (no class refs in user config).
 */
export interface XrplTreasuryConfigInput {
  /** Auto-deposit surplus RLUSD into the vault and auto-withdraw before payments. @default false */
  autoYield?: boolean;
  /** Decimal RLUSD kept liquid; surplus is swept to vault. @default "10" */
  minIdleBalance?: string;
  /** Existing vault to use; takes precedence over autoCreate. */
  vaultId?: string;
  /** Auto-provision a vault on first run when vaultId missing. @default false */
  autoCreate?: boolean;
  /** Debounce window (ms) for post-payment sweep coalescing. @default 30_000 */
  sweepDebounceMs?: number;
}

// ─── Flare (v0.15) ───────────────────────────────────────────────────────────

export type FlareNetwork = 'coston2-testnet';

/**
 * Flare FXRP bridge configuration.
 *
 * v0.15 ships a mint-only MVP: XRP → FXRP via FAssets direct-minting on Coston2,
 * with the 32-byte memo format. Caller's PersonalAccount is the auto-resolved recipient.
 * Mainnet, redemption, and the FXRP paywall adapter land in v0.16+.
 */
export interface FlareConfig {
  /** Flare network. Only Coston2 testnet is supported in v0.15. @default 'coston2-testnet' */
  network?: FlareNetwork;
  /** Override Flare RPC URL. Default: per-network public Coston2 cluster. */
  rpcUrl?: string;
  /**
   * Override the FlareContractRegistry root address.
   * Default: 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019 (canonical across mainnet/Coston2/Songbird).
   */
  contractRegistry?: `0x${string}`;
  /** Throw on missing rpcUrl/credentials instead of warning + disabling. @default false */
  strict?: boolean;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export type { OWSConfig } from './ows/types.js';
import type { OWSConfig } from './ows/types.js';

export interface GoatCredentials {
  apiKey: string;
  apiSecret: string;
  merchantId: string;
  apiUrl?: string;
}

export interface BtcLendingConfig {
  vaultAddress: string;
  collateralRatio?: number;
}

export interface StellarConfig {
  /** Server-side secret key (S...). Optional: agents in browsers use FreighterStellarSigner instead. */
  secretKey?: string;
  /** Public key cache. Derived from secretKey when present. */
  publicKey?: string;
  /** Trustless Work integration (escrow). */
  trustlessWork?: { apiUrl?: string; apiKey?: string };
  /** OpenZeppelin Channels facilitator API key (mainnet). Get one at https://channels.openzeppelin.com/gen */
  channelsApiKey?: string;
  /** Override facilitator base URL. Default: Coinbase x402 (testnet, free) or OZ Channels (mainnet, requires apiKey). */
  facilitatorUrl?: string;
  /** Server-side fee payer secret key (S...) for sponsored fees in MPP Charge. Optional. */
  feePayerSecret?: string;
  /** Stellar RPC URL override. Default: Soroban testnet/mainnet. */
  rpcUrl?: string;
  /** Override SEP-41 token contract for x402 / MPP Charge (default: USDC SAC). */
  usdcSac?: string;
  /** Throw on missing credentials instead of warning. */
  strict?: boolean;
}

/**
 * Morph Network configuration. v0.9 supports x402 facilitator with HMAC auth.
 * AltFee (gas-in-stablecoin Type-0x7F transactions) is scaffolded only — enabling it throws NOT_IMPLEMENTED.
 */
export interface MorphConfig {
  /** Access Key from Morph x402 Console (morph_ak_...). Optional in credential-less dev mode. */
  accessKey?: string;
  /** Secret Key from Morph x402 Console (morph_sk_...). Optional in credential-less dev mode. */
  secretKey?: string;
  /** Override facilitator base URL (defaults to chain.facilitator). */
  facilitatorUrl?: string;
  /** Throw on missing credentials instead of warning. */
  strict?: boolean;
  /** AltFee gas abstraction config — v0.10 feature, throws NOT_IMPLEMENTED if enabled. */
  altFee?: { enabled?: boolean; token?: 'USDC' | 'USDT0' | 'BGB' };
}

// ─── SpaceRouter (v0.11) ─────────────────────────────────────────────────────

export type SpaceRouterRegion = string;            // ISO 3166-1 alpha-2 (e.g. 'US', 'KR', 'JP')
export type SpaceRouterIpType = 'residential' | 'mobile' | 'business' | 'hosting';

/**
 * SpaceRouter (SpaceCoin) configuration. v0.11 ships an agentic-bandwidth layer:
 * residential proxy routing on Creditcoin paid in $SPACE, with on-chain escrow
 * and EIP-712 receipts. See docs.spacecoin.org/spacerouter-proxy.
 */
export interface SpaceRouterConfig {
  /** Proxy gateway URL (CONNECT, port 443/8080). Default: https://gateway.spacerouter.org */
  gatewayUrl?: string;
  /** Management API URL (port 8081, /auth/challenge + /leg1/*). Default: gatewayUrl + ':8081'. */
  gatewayMgmtUrl?: string;
  /** API key (sr_live_... or sr_test_...). Optional — gateway may also accept wallet-signed challenges. */
  apiKey?: string;
  /** Override TokenPaymentEscrow address (defaults to canonical mainnet/testnet address). */
  escrowContract?: string;
  /** Override SPACE/SPC token address (defaults to canonical chain token). */
  tokenAddress?: string;
  /** Default region for routing (2-letter ISO code). Per-call overridable via PaymentContext.region. */
  region?: SpaceRouterRegion;
  /** Default IP type. Per-call overridable. */
  ipType?: SpaceRouterIpType;
  /** Auto-managed escrow + receipt sync. Omit for fully manual. */
  autoEscrow?: {
    /** Auto-deposit when escrow balance drops below this (wei). */
    minBalance?: bigint;
    /** Amount to deposit on auto top-up (wei). */
    topUpAmount?: bigint;
    /** Sync receipts after this many requests (or on close()). */
    claimThreshold?: number;
    /** Sync receipts every N ms (or on close()). */
    syncIntervalMs?: number;
  };
  /** Throw on missing credentials/peer-dep instead of warning. */
  strict?: boolean;
  /** TLS verify (set false only for self-signed test gateways). */
  verify?: boolean;
}

// ─── Aave (v0.13) ────────────────────────────────────────────────────────────

export interface AaveConfig {
  /** Auto-supply idle funds to Aave for yield. */
  autoYield?: boolean;
  /** Minimum balance to keep liquid (wei). Rest goes to Aave. Default: 10 USDC. */
  minIdleBalance?: bigint;
  /** Allow borrowing GHO against collateral for payments. */
  borrowEnabled?: boolean;
  /** Max loan-to-value ratio (1-90). Default: 70. */
  maxLTV?: number;
  /** Prefer GHO for payments when the server accepts it. */
  preferGho?: boolean;
  /** ERC-4626 vault config for agent treasury. */
  vault?: { enabled?: boolean; feePercent?: number };
  /** Credit delegation for multi-agent spending. */
  delegation?: { enabled?: boolean; delegates?: string[]; maxPerDelegate?: bigint };
}

export interface NPaymentConfig {
  chains: ChainKey[];
  ows: OWSConfig;
  protocol?: ProtocolType;
  autoFaucet?: boolean;
  x402?: { facilitatorUrl?: string; usePermit2?: boolean };
  mpp?: { currency?: string };
  goat?: GoatCredentials;
  btcLending?: BtcLendingConfig;
  xrpl?: XrplConfig;
  stellar?: StellarConfig;
  morph?: MorphConfig;
  spacerouter?: SpaceRouterConfig;
  analytics?: { plugins?: AnalyticsPlugin[] };
  // v0.8: Circle Gateway nanopayments
  circle?: { apiKey: string; environment?: 'sandbox' | 'production'; walletId?: string };
  // v0.8: Solana x402
  solana?: { rpcUrl?: string; keypair?: string; facilitator?: string };
  // v0.8: Policy engine
  policy?: { maxPerTransaction?: bigint; maxPerHour?: bigint; maxPerDay?: bigint; rateLimit?: { maxRequests: number; windowMs: number }; blocklist?: string[]; trustedFacilitators?: string[] };
  // v0.8: AP2 protocol
  ap2?: { agentId: string; signingKey?: string };
  // v0.8: Batch settlement
  batchSettlement?: { enabled?: boolean; escrowContract?: string; autoSettleThreshold?: number };
  // v0.8: Streaming payments
  streaming?: { defaultInterval?: number; autoRenew?: boolean };
  // v0.13: Aave yield-bearing treasury
  aave?: AaveConfig;
  // v0.15: Flare FXRP direct-minting bridge
  flare?: FlareConfig;
}

// ─── Adapter Interface (SOLID: Interface Segregation) ────────────────────────

/**
 * Per-call payment context. Forwarded from PaymentClient.fetchWithPayment to adapters.
 * Used for merchant order tracking (referenceKey) and arbitrary metadata.
 */
export interface PaymentContext {
  /** Merchant order identifier — first-class on Morph (Reference Key); recorded in audit on all chains. */
  referenceKey?: string;
  /** Arbitrary key/value metadata persisted in audit log. */
  metadata?: Record<string, string>;
  /** v0.11: route through a residential proxy network. 'auto' = direct first, fallback on 403/429/CF-block. */
  proxy?: 'spacerouter' | 'auto' | 'none';
  /** v0.11: ISO 3166-1 alpha-2 region code for proxy routing (e.g. 'US', 'KR'). */
  region?: SpaceRouterRegion;
  /** v0.11: IP-type filter for proxy routing. */
  ipType?: SpaceRouterIpType;
}

export interface PaymentAdapter {
  readonly protocol: string;
  detect(response: Response): boolean;
  pay(url: string, init: RequestInit | undefined, response: Response, ctx?: PaymentContext): Promise<Response>;
}

/**
 * v0.11 ProxyAdapter — a parallel-but-distinct interface to PaymentAdapter.
 * Where PaymentAdapter responds to a 402 challenge, ProxyAdapter routes a request through
 * a paid bandwidth network (SpaceRouter today; Tor / Mysterium tomorrow).
 *
 * `detect(ctx)` — returns true when the adapter wants to handle the routing for this context.
 * `route()` — performs the proxied fetch. Caller should still feed the result through the
 *             402 paywall pipeline if needed.
 */
export interface ProxyAdapter {
  readonly protocol: string;
  detect(ctx: PaymentContext | undefined, response?: Response): boolean;
  route(url: string, init: RequestInit | undefined, ctx?: PaymentContext): Promise<Response>;
  /** Optional: graceful shutdown (flush receipts, close timers). */
  close?(): Promise<void>;
}

// ─── Analytics ───────────────────────────────────────────────────────────────

export interface PaymentEvent {
  protocol: string;
  chain: string;
  url: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

export interface AnalyticsPlugin {
  emit(event: PaymentEvent): void;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export interface PaywallRouteConfig {
  price: string;
  description?: string;
  x402?: { payTo: string; asset?: string; network?: string; facilitator?: string };
  mpp?: { currency?: string; recipient?: string };
  xrpl?: { payTo: string; asset?: string; network?: string };
  morph?: { payTo: string; asset?: string; network?: string };
}

export interface PaywallConfig {
  routes: Record<string, PaywallRouteConfig>;
  x402?: { facilitatorUrl?: string };
  mpp?: { currency?: string; recipient?: string };
  /** Default facilitator URL for payment verification. Per-route x402.facilitator overrides this. */
  facilitator?: string;
}

// ─── Discovery (Bazaar) ──────────────────────────────────────────────────────

export interface BazaarResource {
  resource: string;
  type: 'http' | 'mcp';
  description?: string;
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    maxAmountRequired: string;
    payTo: string;
  }>;
  metadata?: Record<string, unknown>;
}

export interface BazaarSearchResult {
  resources: BazaarResource[];
  total: number;
}

// ─── Off-Ramp ────────────────────────────────────────────────────────────────

export interface OffRampAdapter {
  readonly provider: string;
  getSupportedCurrencies(): Promise<string[]>;
  getQuote(params: OffRampQuoteParams): Promise<OffRampQuote>;
  withdraw(params: OffRampWithdrawParams): Promise<OffRampReceipt>;
}

export interface OffRampQuoteParams {
  amount: string;
  token: string;
  chain: ChainKey;
  fiatCurrency: string;
}

export interface OffRampQuote {
  fiatAmount: string;
  fiatCurrency: string;
  feePercent: number;
  estimatedDays: number;
}

export interface OffRampWithdrawParams {
  amount: string;
  token: string;
  chain: ChainKey;
  destination: { type: 'bank_account' | 'card' | 'mobile_money'; id: string };
}

export interface OffRampReceipt {
  id: string;
  status: 'processing' | 'completed' | 'failed';
  fiatAmount: string;
  fiatCurrency: string;
  estimatedArrival: string;
}