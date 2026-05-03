// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  ProtocolType, ChainKey, ChainConfig, NPaymentConfig, GoatCredentials,
  PaymentAdapter, PaymentEvent, AnalyticsPlugin, PaywallRouteConfig, PaywallConfig,
  OWSConfig, BtcLendingConfig,
} from './types.js';

// ─── OWS ─────────────────────────────────────────────────────────────────────
export { OWSWallet } from './ows/wallet.js';
export type { OWSSignResult, OWSExecResult } from './ows/types.js';
export type { TransactionRequest } from './ows/wallet.js';

// ─── Core ────────────────────────────────────────────────────────────────────
export { CHAINS, getChain, getChainsForProtocol } from './chains.js';
export { createConfig } from './config.js';
export { detectProtocol } from './detect.js';
export { NPaymentError, ChallengeParseError, InsufficientBalanceError, AdapterNotFoundError } from './errors.js';
export { ConsoleAnalytics, AnalyticsEmitter } from './analytics.js';

// ─── Client ──────────────────────────────────────────────────────────────────
export { PaymentClient, createPaymentClient } from './client.js';

// ─── Middleware ───────────────────────────────────────────────────────────────
export { createPaywall, createHealthEndpoint } from './middleware.js';

// ─── GOAT Network ────────────────────────────────────────────────────────────
export { GoatX402Client } from './goat/client.js';
export { GoatIdentity, GOAT_IDENTITY_REGISTRY, GOAT_REPUTATION_REGISTRY } from './goat/identity.js';
export { signGoatRequest } from './goat/auth.js';
export type { GoatOrder, GoatProof, GoatCreateOrderParams, GoatOrderStatus } from './goat/types.js';

// ─── BTC Lending ─────────────────────────────────────────────────────────────
export { BtcLendingVault } from './goat/lending.js';
