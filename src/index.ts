// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  ProtocolType, ChainKey, ChainConfig, NPaymentConfig, GoatCredentials,
  PaymentAdapter, PaymentEvent, AnalyticsPlugin, PaywallRouteConfig, PaywallConfig,
  OWSConfig, BtcLendingConfig, XrplConfig, StellarConfig,
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

// ─── Stellar & Trustless Work ────────────────────────────────────────────────
export { StellarWallet } from './stellar/wallet.js';
export type { StellarWalletConfig } from './stellar/wallet.js';
export { TrustlessWorkClient } from './stellar/trustless-work.js';
export type { TrustlessWorkConfig, EscrowDeployParams, EscrowStatus } from './stellar/trustless-work.js';
export { TrustlessEscrowManager } from './stellar/escrow-manager.js';
export type { TrustlessJob, TrustlessJobStatus, TrustlessEscrowConfig } from './stellar/escrow-manager.js';
export { StellarX402Adapter } from './adapters/stellar-x402.js';
export { StellarMppAdapter } from './adapters/stellar-mpp.js';

// ─── XRPL (Ripple) ──────────────────────────────────────────────────────────
export { XrplClient, createXrplClient } from './xrpl/client.js';
export type { XrplClientConfig } from './xrpl/client.js';
export { XrplWallet } from './xrpl/wallet.js';
export { XrplConnection } from './xrpl/connection.js';
export { XrplVaultClient } from './xrpl/vault.js';
export type { VaultCreateOptions, VaultInfo } from './xrpl/vault.js';
export { DiaOracleClient } from './xrpl/oracle.js';
export type { OraclePrice } from './xrpl/oracle.js';
export { ensureTrustLine, sendRLUSD, getRLUSDBalance } from './xrpl/payments.js';
export { XrplAdapter } from './adapters/xrpl.js';

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
