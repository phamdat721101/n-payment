// ─── Protocol & Chain ────────────────────────────────────────────────────────

export type ProtocolType = 'x402' | 'mpp' | 'auto';

export type ChainKey =
  | 'base-sepolia'
  | 'arbitrum-sepolia'
  | 'goat-testnet'
  | 'tempo-testnet'
  | 'tempo-mainnet'
  | 'base-mainnet';

export interface ChainConfig {
  chainId: number;
  caip2: string;
  name: string;
  rpcUrl: string;
  protocols: string[];
  tokens: Record<string, string>;
  facilitator?: string;
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

export interface NPaymentConfig {
  chains: ChainKey[];
  ows: OWSConfig;
  protocol?: ProtocolType;
  autoFaucet?: boolean;
  x402?: { facilitatorUrl?: string };
  mpp?: { currency?: string };
  goat?: GoatCredentials;
  btcLending?: BtcLendingConfig;
  analytics?: { plugins?: AnalyticsPlugin[] };
}

// ─── Adapter Interface (SOLID: Interface Segregation) ────────────────────────

export interface PaymentAdapter {
  readonly protocol: string;
  detect(response: Response): boolean;
  pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response>;
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