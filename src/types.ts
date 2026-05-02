// ─── Protocol & Chain ────────────────────────────────────────────────────────

export type ProtocolType = 'x402' | 'mpp' | 'auto';

export type ChainKey =
  | 'base-sepolia'
  | 'arbitrum-sepolia'
  | 'goat-testnet'
  | 'goat-mainnet'
  | 'tempo-testnet';

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

export interface NPaymentConfig {
  chains: ChainKey[];
  ows: OWSConfig;
  protocol?: ProtocolType;
  x402?: { facilitatorUrl?: string };
  mpp?: { currency?: string };
  goat?: GoatCredentials;
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
