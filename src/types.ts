// ─── Protocol & Chain ────────────────────────────────────────────────────────

export type ProtocolType = 'x402' | 'mpp' | 'xrpl' | 'stellar-x402' | 'stellar-mpp' | 'stellar-mpp-session' | 'morph-x402' | 'auto';

export type ChainKey =
  | 'base-sepolia'
  | 'arbitrum-sepolia'
  | 'goat-testnet'
  | 'goat-mainnet'
  | 'tempo-testnet'
  | 'tempo-mainnet'
  | 'base-mainnet'
  | 'xrpl-testnet'
  | 'xrpl-mainnet'
  | 'stellar-testnet'
  | 'stellar-mainnet'
  | 'solana-mainnet'
  | 'solana-devnet'
  | 'morph-mainnet'
  | 'morph-hoodi-testnet';

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

export interface XrplConfig {
  seed?: string;
  server?: string;
  network?: 'testnet' | 'mainnet';
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
  analytics?: { plugins?: AnalyticsPlugin[] };
  // v0.8: Circle Gateway nanopayments
  circle?: { apiKey: string; environment?: 'sandbox' | 'production'; walletId?: string };
  // v0.8: Solana x402
  solana?: { rpcUrl?: string; keypair?: string; facilitator?: string };
  // v0.8: Policy engine
  policy?: { maxPerTransaction?: bigint; maxPerHour?: bigint; maxPerDay?: bigint; rateLimit?: { maxRequests: number; windowMs: number }; blocklist?: string[] };
  // v0.8: AP2 protocol
  ap2?: { agentId: string; signingKey?: string };
  // v0.8: Batch settlement
  batchSettlement?: { enabled?: boolean; escrowContract?: string; autoSettleThreshold?: number };
  // v0.8: Streaming payments
  streaming?: { defaultInterval?: number; autoRenew?: boolean };
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
}

export interface PaymentAdapter {
  readonly protocol: string;
  detect(response: Response): boolean;
  pay(url: string, init: RequestInit | undefined, response: Response, ctx?: PaymentContext): Promise<Response>;
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
  x402?: { payTo: string; asset?: string; network?: string };
  mpp?: { currency?: string; recipient?: string };
  xrpl?: { payTo: string; asset?: string; network?: string };
  morph?: { payTo: string; asset?: string; network?: string };
}

export interface PaywallConfig {
  routes: Record<string, PaywallRouteConfig>;
  x402?: { facilitatorUrl?: string };
  mpp?: { currency?: string; recipient?: string };
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