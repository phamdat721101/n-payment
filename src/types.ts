// ─── Protocol & Chain ────────────────────────────────────────────────────────

export type ProtocolType = 'x402' | 'mpp' | 'xrpl' | 'stellar-x402' | 'stellar-mpp' | 'stellar-mpp-session' | 'morph-x402' | 'spacerouter' | 'flare-fxrp' | 'flare-x402' | 'wormhole-ntt' | 'rlusd-exact' | 'cosmos-msgsend' | 'celo-fee-abstracted' | 'auto';

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
  | 'flare-coston2-testnet'
  | 'flare-songbird-mainnet'
  | 'flare-mainnet'
  // v0.22 — RLUSD multichain via Wormhole NTT
  | 'ethereum-mainnet'
  | 'optimism-mainnet'
  | 'ink-mainnet'
  | 'unichain-mainnet'
  // v0.23 — Cosmos-SDK / Initia (USDC-EVM → iUSD-Initia bridge corridor)
  | 'initia-mainnet'
  | 'initia-testnet'
  // v0.25 — Celo L2 (CIP-64 fee abstraction + Mento corridor + Agent Visa)
  | 'celo-mainnet'
  | 'celo-sepolia';

// ─── Celo (v0.25) ────────────────────────────────────────────────────────────

/** Celo Agent Visa tier — mirrors self.xyz/blog/agent-visa criteria. */
export type CeloAgentVisaTier = 'none' | 'tourist' | 'work' | 'citizenship';

/** Persisted Agent Visa state for a single agent address. */
export interface AgentVisaState {
  agentAddress: `0x${string}`;
  txCount: number;
  /** Cumulative payment volume in USD (best-effort, payAsset-agnostic). */
  volumeUsd: number;
  selfAgentIdProvided: boolean;
  tier: CeloAgentVisaTier;
  firstTxAt: number;
  lastTxAt: number;
  network: 'mainnet' | 'sepolia';
}

/**
 * Pluggable storage backend for Agent Visa state. Single-responsibility
 * interface — any backend (memory, JSON file, Redis, DynamoDB) can implement
 * this without touching the tracker logic.
 */
export interface AgentVisaStorage {
  read(agentAddress: `0x${string}`): Promise<AgentVisaState | null>;
  write(state: AgentVisaState): Promise<void>;
}

/**
 * v0.25 Celo configuration. All fields optional — the SDK soft-disables the
 * Celo adapter when this config is absent (warn + skip, mirrors Morph/Flare
 * pattern). Provide `celo: {}` to opt-in with all defaults.
 */
export interface CeloConfig {
  /** Celo network. @default inferred from chains[] (sepolia if 'celo-sepolia' present, else mainnet) */
  network?: 'mainnet' | 'sepolia';
  /** Override Celo RPC URL. Default: per-network public Forno endpoint. */
  rpcUrl?: string;
  /** Token symbol used for both gas and payment via CIP-64. @default 'USDC' */
  payAsset?: 'USDC' | 'USDT' | 'USDm';
  /** Override fee-currency adapter address (escape hatch for new tokens). */
  feeCurrencyAdapterOverride?: `0x${string}`;
  /** Soft-disable fee abstraction; fall back to standard EIP-1559 (CELO gas). @default false */
  disableFeeAbstraction?: boolean;
  /** Throw on missing config / signer instead of warning + disabling. @default false */
  strict?: boolean;
  /** Mento corridor sub-config (USDm/cKES/cREAL → USDC). */
  mento?: {
    /** Override Mento Broker contract address. */
    brokerOverride?: `0x${string}`;
    /** Max acceptable slippage in basis points. @default 50 (0.5%) */
    maxSlippageBps?: number;
  };
  /** Agent Visa tracker sub-config. */
  agentVisa?: {
    /** Pluggable storage backend. @default new MemoryAgentVisaStorage() */
    storage?: AgentVisaStorage;
    /** Set true if agent has a verified Self Agent ID — enables Work-tier upgrade. @default false */
    selfAgentIdProvided?: boolean;
  };
}

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

// ─── Flare (v0.15 + v0.19) ───────────────────────────────────────────────────

export type FlareNetwork = 'coston2-testnet' | 'songbird-mainnet' | 'flare-mainnet';

/**
 * v0.19: x402-on-Flare (MockUSDT0) buyer + merchant config.
 * Flare's x402 spec uses an on-chain X402Facilitator (not an HTTP service);
 * both addresses must be caller-supplied (use the deploy helper in
 * src/flare/x402.ts). EIP-712 domain defaults are 'Mock USDT0' / version '1'
 * to match Flare's published demo — override when FXRP itself eventually
 * implements EIP-3009 and the same adapter is used with FXRP as the asset.
 */
export interface FlareX402Config {
  /** EIP-3009 token (MockUSDT0 today, FXRP once it implements EIP-3009). */
  tokenAddress: `0x${string}`;
  /** Deployed X402Facilitator contract (verifyPayment + settlePayment). */
  facilitatorAddress: `0x${string}`;
  /** EIP-712 domain name on the token contract. @default 'Mock USDT0' */
  tokenName?: string;
  /** EIP-712 domain version on the token contract. @default '1' */
  tokenVersion?: string;
  /** Authorization lifetime in seconds. @default 300 (5 min) */
  validityWindowSeconds?: number;
}

/**
 * v0.19: Gasless FXRP forwarder config. Different EIP-712 type than x402 —
 * uses GaslessPaymentForwarder.PaymentRequest, not EIP-3009. One-time
 * approve(MaxUint256) is required before the first payment.
 */
export interface FlareGaslessConfig {
  /** Deployed GaslessPaymentForwarder contract. */
  forwarderAddress: `0x${string}`;
  /** Relayer HTTP base URL (must expose POST /execute and GET /nonce/:addr). */
  relayerUrl: string;
  /** Default deadline window in seconds. @default 1800 (30 min) */
  deadlineSeconds?: number;
}

/**
 * Flare configuration. v0.15 ships FXRP minting; v0.19 adds x402 (MockUSDT0)
 * and gasless FXRP transfers. Sub-configs are optional — the SDK soft-disables
 * each adapter when its config is absent (warn + skip, mirrors Morph pattern).
 */
export interface FlareConfig {
  /** Flare network. @default 'coston2-testnet' */
  network?: FlareNetwork;
  /** Override Flare RPC URL. Default: per-network public cluster. */
  rpcUrl?: string;
  /**
   * Override the FlareContractRegistry root address.
   * Default: 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019 (canonical across mainnet/Coston2/Songbird).
   */
  contractRegistry?: `0x${string}`;
  /** Throw on missing rpcUrl/credentials instead of warning + disabling. @default false */
  strict?: boolean;
  /** v0.19: x402 (MockUSDT0) buyer config. */
  x402?: FlareX402Config;
  /** v0.19: Gasless FXRP forwarder config. */
  gasless?: FlareGaslessConfig;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export type { OWSConfig } from './ows/types.js';
import type { OWSConfig } from './ows/types.js';

export interface GoatCredentials {
  apiKey: string;
  apiSecret: string;
  merchantId: string;
  apiUrl?: string;
  /**
   * v0.17 — opt into auto-funding USDC on a GOAT 402 challenge.
   * The router inspects the agent's balance sheet and picks the cheapest
   * available path: in-GOAT PegBTC→USDC swap, cross-chain LayerZero V2 OFT,
   * or BTC L1 BitVM peg-in. Off by default (caller must explicitly enable).
   */
  autoFund?: GoatAcquisitionConfig;
  /** Hosted BitVM bridge endpoint. Default: https://bridge.goat.network */
  bridgeUrl?: string;
  /** External BTC signer for Path 3. Required only if 'pegin' is in allowedPaths. */
  btcSigner?: BtcSigner;
  /** Override OKU router/quoter addresses (escape hatch). */
  dexOverride?: { router?: `0x${string}`; quoter?: `0x${string}` };
  /** Override resolved USDC address on GOAT (escape hatch). Emits a console warning when active. */
  usdcOverride?: `0x${string}`;
}

/** v0.17: which acquisition rail the router may use. */
export type AcquisitionPath = 'swap' | 'oft' | 'pegin';

/**
 * v0.17 GOAT USDC acquisition config. Fully optional; safe defaults are exposed via
 * `GoatAcquisitionPresets.safeDefaults()` (see src/goat/acquisition.ts).
 */
export interface GoatAcquisitionConfig {
  /** Master switch. When true, GoatAdapter auto-acquires USDC on 402 if short. */
  enabled: boolean;
  /** Subset of paths the router may choose from. Default: ['swap']. */
  allowedPaths?: AcquisitionPath[];
  /** Max acquisition spend per rolling hour, USDC wei (6-dec). */
  maxPerHour?: bigint;
  /** Max acquisition spend per rolling day, USDC wei (6-dec). */
  maxPerDay?: bigint;
  /** Max bridge/OFT fee tolerance in basis points. Default: 100 (1%). */
  maxFeeBps?: number;
  /** Max acceptable slippage on the on-GOAT swap leg, basis points. Default: 50 (0.5%). */
  maxSlippageBps?: number;
  /** When true, router quotes but does not execute. Useful for ops dry-runs. */
  dryRun?: boolean;
}

/**
 * v0.17 — caller-supplied BTC L1 signer for the BitVM peg-in path.
 * **The SDK never holds BTC keys.** The signer is invoked only after the SDK
 * has independently validated that the PSBT outputs match the bridge intent
 * (see GOAT_BRIDGE_PSBT_TAMPERED safeguard).
 */
export interface BtcSigner {
  /** Sign a PSBT (base64-encoded). Must return a fully signed, broadcastable transaction hex. */
  signPsbt(psbtBase64: string): Promise<string>;
  /** Return the BTC L1 address (P2WPKH or P2TR string) the signer controls. */
  getAddress(): Promise<string>;
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
  /**
   * v0.20: Override the EIP-712 domain `name` for `transferWithAuthorization`
   * signing under scheme=eip3009. Required on chains where the deployed USDC
   * uses a non-default name — e.g. Morph Hoodi USDC reports `name() = 'USDC'`,
   * NOT the Circle FiatTokenV2 default of `'USD Coin'`. When omitted the SDK
   * auto-resolves by reading `name()` from the asset contract.
   */
  tokenName?: string;
  /** v0.20: Override the EIP-712 domain `version` (default auto-resolves via `version()`, then '2'). */
  tokenVersion?: string;
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

// ─── Wormhole NTT (v0.22) ────────────────────────────────────────────────────

import type {
  EvmSigner,
  WormholeChainName,
  WormholeNttBridgeFactory,
} from './wormhole/types.js';

/**
 * v0.22: Wormhole NTT cross-chain RLUSD config. All fields optional — if
 * `signers` is missing the SDK soft-disables the cross-chain RLUSD lane and
 * the corridor (PRD-C) skips ntt-bridge decisions.
 */
export interface WormholeConfig {
  /** Per-chain EVM signer (ethers.Wallet, viem.WalletClient, or OWS adapter). */
  signers?: Partial<Record<WormholeChainName, EvmSigner>>;
  /** Override default bridge factory (advanced; default wraps @wormhole-foundation/sdk-evm-ntt). */
  bridgeFactory?: WormholeNttBridgeFactory;
  /** Wormhole network env. Default 'Mainnet'. */
  network?: 'Mainnet' | 'Testnet';
  /** Per-call max RLUSD bridge amount (UBA — 18 decimals). */
  maxPerTransfer?: bigint;
  /** Rolling 24h cap (UBA). */
  maxPerDay?: bigint;
  /** VAA polling timeout (ms). Default 600_000. */
  attestationTimeoutMs?: number;
  /** VAA polling interval (ms). Default 5_000. */
  attestationPollMs?: number;
  /** Throw on missing signer instead of skipping. Default false. */
  strict?: boolean;
}

/**
 * v0.22.1: XRPFi unified corridor config (PRD-G). Composes existing FlareConfig
 * (FXRP minting/redemption) + XrplConfig (RLUSD-XRPL swap) + WormholeConfig
 * (optional reverse-bridge). All fields optional — if absent the corridor
 * never emits XRPFi decisions.
 */
export interface XrpfiConfig {
  /** Master switch — when true, PayRouter emits xrpfi-* decisions. Default false. */
  enabled?: boolean;
  /** Redemption poll timeout (ms). Default 600_000 (10 min). */
  redemptionTimeoutMs?: number;
  /** XRPL XRP→RLUSD swap slippage cap (bps). Default 100 (1%). */
  swapMaxSlippageBps?: number;
  /** Allow the future XRPL → EVM bridge step. Default false; activates when XRPL is added to RLUSD_NTT_DEPLOYMENTS. */
  allowReverseBridge?: boolean;
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
  // v0.22: Wormhole NTT cross-chain RLUSD
  wormhole?: WormholeConfig;
  // v0.22.1: Unified XRPFi corridor (XRP ↔ FXRP ↔ RLUSD round-trip)
  xrpfi?: XrpfiConfig;
  // v0.23: Initia (Cosmos-SDK) + iUSD bridge corridor
  initia?: import('./initia/types.js').InitiaConfig;
  iusd?: import('./initia/types.js').IusdConfig;
  // v0.25: Celo L2 (CIP-64 fee abstraction + Mento corridor + Agent Visa)
  celo?: CeloConfig;
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
  x402?: {
    payTo: string;
    /** Asset symbol or ERC-20 address. Default 'USDC'. */
    asset?: string;
    network?: string;
    /** Optional facilitator URL. When omitted, merchants self-verify on-chain (v0.22 PRD-D). */
    facilitator?: string;
    /** v0.22: payment scheme. 'exact' = on-chain transfer + log proof. 'wormhole-ntt-transfer' = bridge-as-payment. Default 'exact'. */
    scheme?: 'exact' | 'wormhole-ntt-transfer';
  };
  mpp?: { currency?: string; recipient?: string };
  xrpl?: { payTo: string; asset?: string; network?: string };
  /**
   * Morph paywall route. `scheme` defaults to 'exact' (Morph mainnet direct transfer).
   * Set `scheme: 'eip3009'` for sponsored EIP-3009 transferWithAuthorization on Hoodi (v0.18).
   */
  morph?: { payTo: string; asset?: string; network?: string; scheme?: 'exact' | 'eip3009' };
  /**
   * v0.19: Flare x402 paywall route. The merchant calls X402Facilitator on-chain to
   * verify + settle payments (EIP-3009 transferWithAuthorization on MockUSDT0).
   * Defaults: `network='flare-coston2'`, `chainId=114`, `tokenName='Mock USDT0'`,
   * `tokenVersion='1'`. Override per-deploy.
   */
  flare?: {
    payTo: `0x${string}`;
    asset: `0x${string}`;
    facilitatorAddress: `0x${string}`;
    network?: string;
    chainId?: number;
    tokenName?: string;
    tokenVersion?: string;
  };
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