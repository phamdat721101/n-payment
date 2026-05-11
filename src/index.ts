// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  ProtocolType, ChainKey, ChainConfig, NPaymentConfig, GoatCredentials,
  PaymentAdapter, PaymentEvent, AnalyticsPlugin, PaywallRouteConfig, PaywallConfig,
  OWSConfig, BtcLendingConfig,
} from './types.js';
export type {
  BazaarResource, BazaarSearchResult,
  OffRampAdapter, OffRampQuoteParams, OffRampQuote, OffRampWithdrawParams, OffRampReceipt,
} from './types.js';

// ─── OWS ─────────────────────────────────────────────────────────────────────
export { OWSWallet } from './ows/wallet.js';
export type { OWSSignResult } from './ows/types.js';
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
export { createPaywall, createMppPaywall, createHealthEndpoint } from './middleware.js';

// ─── GOAT Network ────────────────────────────────────────────────────────────
export { GoatX402Client } from './goat/client.js';
export { GoatIdentity, GOAT_IDENTITY_REGISTRY, GOAT_REPUTATION_REGISTRY } from './goat/identity.js';
export { signGoatRequest } from './goat/auth.js';
export type { GoatOrder, GoatProof, GoatCreateOrderParams, GoatOrderStatus } from './goat/types.js';

// ─── BTC Lending ─────────────────────────────────────────────────────────────
export { BtcLendingVault } from './goat/lending.js';

// ─── Bazaar (Discovery) ──────────────────────────────────────────────────────
export { BazaarClient, createBazaarClient, MOCK_CATALOG } from './bazaar/index.js';
export type { BazaarClientConfig } from './bazaar/index.js';

// ─── Off-Ramp ────────────────────────────────────────────────────────────────
export { OffRampClient, MockMoonPayAdapter } from './offramp/index.js';

// ─── Faucet ──────────────────────────────────────────────────────────────────
export { TestnetFaucet } from './faucet.js';

// ─── Transactor ──────────────────────────────────────────────────────────────
export { ViemTransactor } from './transactor.js';
export type { TransactionResult } from './transactor.js';

// ─── Agent Commerce (v0.5) ─────────────────────────────────────────────────
export {
  paidTool, AgentProvider, createAgentProvider,
  AgentClient, createAgentClient,
  PricingEngine, DemandStrategy, ReputationStrategy, OutcomeStrategy,
  SessionManager, EscrowManager, PaymentNegotiator,
  ReputationRouter, DelegationManager, AgentCard,
} from './agent/index.js';

export type {
  PricingMode, PricingStrategy, PricingContext, PricingConfig,
  Session, SessionConfig, Job, JobStatus, EscrowConfig,
  PaymentTerms, NegotiationResult, NegotiationPolicy,
  DelegationContext, DelegationConfig,
  AgentSkill, AgentCardData, PaidToolDef, ToolCallContext,
  AgentProviderConfig, AgentClientConfig,
  RoutingStrategy, ProviderCandidate, RouterConfig,
} from './agent/index.js';
