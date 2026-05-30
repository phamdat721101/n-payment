// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  ProtocolType, ChainKey, ChainConfig, NPaymentConfig, GoatCredentials,
  PaymentAdapter, PaymentEvent, AnalyticsPlugin, PaywallRouteConfig, PaywallConfig,
  OWSConfig, BtcLendingConfig, XrplConfig, StellarConfig, MorphConfig, PaymentContext,
  SpaceRouterConfig, SpaceRouterRegion, SpaceRouterIpType, ProxyAdapter,
  AaveConfig, FlareConfig, FlareNetwork, FlareX402Config, FlareGaslessConfig,
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

// ─── GOAT USDC Acquisition Router (v0.17) ────────────────────────────────────
export {
  UsdcAcquisitionRouter,
  BalanceSheetStrategy,
  GoatAcquisitionPresets,
  GoatTokens,
  GoatBalances,
  GoatDexSwap,
  LayerZeroOftClient,
  BitVMBridgeClient,
  MockSwapAdapter,
  MockOftAdapter,
  MockBridgeAdapter,
} from './goat/acquisition.js';
export type {
  AcquireParams,
  AcquireResult,
  RoutingDecision,
  AcquisitionRoutingStrategy,
  RouterDeps,
  AcquisitionPathAdapter,
  AcquisitionQuote,
  AcquisitionReceipt,
  BalanceSheet,
} from './goat/acquisition.js';
export type {
  AcquisitionPath,
  GoatAcquisitionConfig,
  BtcSigner,
} from './types.js';
export { GOAT_ACQUISITION_HINTS, goatError } from './errors.js';

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

// ─── Stellar Agentic Payments (v0.10) ────────────────────────────────────────
export { KeypairStellarSigner, FreighterStellarSigner } from './stellar/signer.js';
export type { StellarSigner } from './stellar/signer.js';
export { StellarChannelsClient } from './stellar/channels-client.js';
export type {
  StellarChannelsClientConfig, StellarSupportedKind, StellarSupportedResponse,
  StellarVerifyResponse, StellarSettleResponse,
} from './stellar/channels-client.js';
export { StellarSessionClient, StellarSessionServer } from './stellar/session.js';
export type {
  StellarSessionClientConfig, StellarSessionServerConfig, VoucherCredential,
} from './stellar/session.js';
export type { MppChargeMode } from './adapters/stellar-mpp.js';

// ─── XRPL (Ripple) ──────────────────────────────────────────────────────────
export { XrplClient, createXrplClient } from './xrpl/client.js';
export type { XrplClientConfig, XrplHealthReport } from './xrpl/client.js';
export { XrplWallet } from './xrpl/wallet.js';
export { XrplConnection } from './xrpl/connection.js';
export { XrplVaultClient } from './xrpl/vault.js';
export type { VaultCreateOptions, VaultInfo } from './xrpl/vault.js';
export { DiaOracleClient } from './xrpl/oracle.js';
export type { OraclePrice } from './xrpl/oracle.js';
export {
  ensureTrustLine, sendRLUSD, getRLUSDBalance, readAccountState, clearAccountStateCache,
} from './xrpl/payments.js';
export type { AccountState, IssuerOpts } from './xrpl/payments.js';
export { XrplAdapter } from './adapters/xrpl.js';
export type { XrplAdapterOptions } from './adapters/xrpl.js';
// ─── XRPL v0.14 ─────────────────────────────────────────────────────────────
export {
  RLUSD_ISSUERS, RLUSD_CURRENCY, RLUSD_DECIMALS,
  getRlusdIssuer, networkFromChainKey,
  parseRlusdAmount, formatRlusdAmount,
  padSendMaxDrops, computeQuoteSlippageBps,
} from './xrpl/utils.js';
export type { XrplNetwork } from './xrpl/utils.js';
export { XrplSwapClient } from './xrpl/swap.js';
export type {
  XrplSwapQuote, XrplSwapQuoteOptions, XrplSwapOptions, XrplSwapResult, SwapAsset,
} from './xrpl/swap.js';
export { XrplTreasuryManager, MemoryVaultIdStore } from './xrpl/treasury.js';
export type {
  VaultIdStore, XrplTreasuryConfig, XrplTreasuryDeps, XrplTreasuryState,
} from './xrpl/treasury.js';
export type { XrplTreasuryConfigInput } from './types.js';

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

// ─── Settlement (v0.8) ───────────────────────────────────────────────────────
export {
  BatchSettlementManager, StreamingPaymentManager, Permit2Signer,
} from './settlement/index.js';

export type {
  BatchSessionConfig, BatchVoucher, BatchSession,
  StreamConfig, StreamSession, Permit2Params,
} from './settlement/index.js';

// ─── Policy (v0.8) ──────────────────────────────────────────────────────────
export {
  PolicyEngine, AuditLog, SpendingGuard,
} from './policy/index.js';

export type {
  PolicyRule, PolicyDecision, PaymentRequest, AuditEntry, PolicyConfig,
} from './policy/index.js';

// ─── AP2 Protocol (v0.8) ────────────────────────────────────────────────────
export {
  AP2Client, VerifiableIntentSigner,
} from './ap2/index.js';

export type {
  AP2Config, CheckoutMandate, PaymentMandate, VerifiableIntent,
  MandateConstraints, CartDetails,
} from './ap2/index.js';

// ─── Circle Gateway (v0.8) ──────────────────────────────────────────────────
export { CircleGatewayAdapter } from './adapters/circle-gateway.js';
export type { CircleGatewayConfig } from './adapters/circle-gateway.js';

// ─── Solana x402 (v0.8) ─────────────────────────────────────────────────────
export { SolanaX402Adapter } from './adapters/solana-x402.js';
export type { SolanaX402Config } from './adapters/solana-x402.js';

// ─── Morph Network (v0.9) ───────────────────────────────────────────────────
export { MorphX402Adapter } from './adapters/morph-x402.js';
export { MorphX402Client } from './morph/client.js';
export { signMorphRequest, sortObjectDeep } from './morph/auth.js';
export type {
  MorphX402ClientConfig, MorphSupportedKind, MorphSupportedResponse,
  MorphVerifyResponse, MorphSettleResponse,
} from './morph/client.js';
export type { MorphSignParams } from './morph/auth.js';

// ─── Morph Hoodi Facilitator (v0.18) ────────────────────────────────────────
export { createMorphHoodiFacilitator } from './morph/facilitator.js';
export type { MorphHoodiFacilitatorConfig } from './morph/facilitator.js';
export {
  buildTransferWithAuthorizationTypedData,
  randomEip3009Nonce,
  encodeAuthorizationPayload,
  decodeAuthorizationPayload,
  splitSignature,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  EIP3009_ABI,
} from './morph/eip3009.js';
export type {
  TransferAuthorization, AuthorizationPayload, BuildTypedDataInput, SignableTypedData,
} from './morph/eip3009.js';

// ─── SpaceRouter / SpaceCoin (v0.11) ────────────────────────────────────────
export type {
  SpaceRouterSigner, SpaceRouterReceipt,
  SpaceRouterClientConfig, RoutedResponse,
  EscrowClientConfig, WithdrawalRequest,
  GatewayChallenge, GatewayClientConfig, ReceiptSchedulerConfig,
  SignedReceiptEnvelope, SyncResult,
} from './spacerouter/index.js';
export {
  SpaceRouterClient, SpaceRouterAdapter, SpaceRouterPeerDepMissingError,
  SpaceRouterEscrowClient, SpaceRouterGatewayClient, SpaceRouterReceiptScheduler,
  KeypairSpaceRouterSigner, OWSSpaceRouterSigner, BrowserSpaceRouterSigner,
  EscrowEmptyError, WithdrawalLockedError, WithdrawalAlreadyPendingError,
  spaceRouterDomain, SPACEROUTER_RECEIPT_TYPES,
} from './spacerouter/index.js';

// ─── Aave Treasury (v0.13) ──────────────────────────────────────────────────
export {
  AaveTreasuryManager, AaveClient, YieldManager, GhoManager,
  VaultManager, FlashMintBatcher, DelegationBridge,
  GHO_ADDRESSES, AAVE_POOL_ADDRESSES, GHO_FLASH_MINTER,
} from './aave/index.js';

export type {
  YieldState, VaultConfig, VaultState,
  FlashPayment, FlashBatchResult, Delegation,
} from './aave/index.js';

export { AaveGhoAdapter } from './adapters/aave-gho.js';

// ─── Flare FXRP Bridge (v0.15) + x402 + Gasless (v0.19) ────────────────────
export {
  FlareClient, FlareContractsRegistry, createFlareClient, FLARE_CONTRACT_REGISTRY_ADDRESS,
  getPersonalAccountAddress, isSmartAccount, getOperatorXrplAddresses,
  getFxrpAddress, getFxrpBalance, getFxrpDecimals, getVaults, getAgentVaults,
  parseXrpDropsAmount, formatXrpDropsAmount, computeDirectMintingQuote,
  encodeDirectMintingMemo32, toXrplMemoHex,
  getDirectMintingFees, getDirectMintingPaymentAddress, preflightDirectMintingLimits,
  XRP_SCALE, DIRECT_MINTING_MEMO_PREFIX,
  FlareBridgeClient, createFlareBridgeClient,
  // v0.19
  FlareX402Adapter, verifyAndSettleFlareX402, decodeFlareX402Header,
  buildFlareX402Challenge, deployFlareX402Contracts, X402_FACILITATOR_ABI,
  FlareGaslessForwarderClient, createGaslessExecutor, deployFlareGaslessForwarder,
  PAYMENT_REQUEST_TYPES, FORWARDER_ABI,
} from './flare/index.js';
export type {
  FlareClientConfig, FlareContractName,
  FlareVault, FlareAgentVault,
  DirectMintingFees, DirectMintingQuote, DirectMintingPreflight,
  FlareBridgeConfig, FlareMintParams, FlareMintReceipt,
  // v0.19
  FlareX402Payload, VerifyAndSettleParams, VerifyAndSettleResult,
  ContractArtifact, DeployFlareX402Params, DeployFlareX402Result,
  FlareGaslessClientConfig, FlarePaymentRequest, FlareGaslessStatus,
  FlareGaslessExecuteResult, GaslessRelayerHandlerConfig, DeployFlareGaslessParams,
} from './flare/index.js';

// ─── Flare merchant paywall deps (v0.19) ────────────────────────────────────
export type { FlareMerchantDeps } from './middleware.js';
