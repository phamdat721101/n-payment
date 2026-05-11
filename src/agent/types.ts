import type { ChainKey } from '../types.js';

// ─── Pricing ───────────────────────────────────────────────────────────────────

export type PricingMode = 'per-call' | 'session' | 'outcome';

export interface PricingStrategy {
  resolve(ctx: PricingContext): number; // returns price in token base units
}

export interface PricingContext {
  toolName: string;
  callerAddress?: string;
  callerReputation?: number;
  currentDemand?: number; // requests per minute
  basePrice: number;
}

export interface PricingConfig {
  basePrice: number;
  strategies?: PricingStrategy[];
  min?: number;
  max?: number;
}

// ─── Sessions ──────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  callerAddress: string;
  providerAddress: string;
  budget: number;
  spent: number;
  chain: ChainKey;
  createdAt: number;
  expiresAt: number;
  status: 'active' | 'settled' | 'expired';
}

export interface SessionConfig {
  defaultBudget: number;
  ttlMs?: number; // default 5 min
  settleThreshold?: number; // settle when spent reaches this % of budget
}

// ─── Escrow (ERC-8183) ─────────────────────────────────────────────────────────

export type JobStatus = 'open' | 'funded' | 'submitted' | 'completed' | 'rejected' | 'expired';

export interface Job {
  id: string;
  client: string;
  provider: string;
  evaluator: string;
  amount: number;
  chain: ChainKey;
  status: JobStatus;
  deliverableHash?: string;
  createdAt: number;
  expiresAt: number;
}

export interface EscrowConfig {
  contractAddress: string;
  evaluator: string; // address or 'self'
  chain: ChainKey;
  timeoutMs?: number;
}

// ─── Negotiation ───────────────────────────────────────────────────────────────

export type PaymentTerms = 'direct' | 'escrow' | 'credit';

export interface NegotiationResult {
  terms: PaymentTerms;
  price: number;
  sessionId?: string;
  jobId?: string;
  reason: string;
}

export interface NegotiationPolicy {
  /** Reputation threshold above which credit is offered */
  creditThreshold?: number;
  /** Value threshold above which escrow is required */
  escrowThreshold?: number;
  /** Preferred terms order */
  preferred?: PaymentTerms[];
}

// ─── Delegation ────────────────────────────────────────────────────────────────

export interface DelegationContext {
  parentId?: string;
  rootId: string;
  depth: number;
  totalBudget: number;
  remainingBudget: number;
  maxDepth: number;
  chain: ChainKey;
}

export interface DelegationConfig {
  maxDepth?: number;
  maxPerHopPercent?: number; // max % of remaining budget per hop
}

// ─── Agent Card (A2A) ──────────────────────────────────────────────────────────

export interface AgentSkill {
  name: string;
  description: string;
  price: number;
  pricingMode: PricingMode;
  inputSchema?: Record<string, unknown>;
}

export interface AgentCardData {
  name: string;
  description: string;
  url: string;
  agentId?: bigint; // ERC-8004 on-chain ID
  skills: AgentSkill[];
  chains: ChainKey[];
  protocols: string[]; // ['x402', 'mpp', 'a2a']
  payTo: string;
}

// ─── Provider ──────────────────────────────────────────────────────────────────

export interface PaidToolDef<TInput = any, TOutput = any> {
  name: string;
  description: string;
  price: number | PricingConfig;
  inputSchema?: Record<string, unknown>;
  handler: (input: TInput, ctx: ToolCallContext) => Promise<TOutput>;
}

export interface ToolCallContext {
  callerAddress: string;
  paymentTx?: string;
  sessionId?: string;
  delegationCtx?: DelegationContext;
}

export interface AgentProviderConfig {
  name: string;
  description: string;
  payTo: string;
  chain: ChainKey;
  tools: PaidToolDef[];
  pricing?: Partial<PricingConfig>;
  sessions?: SessionConfig;
  escrow?: EscrowConfig;
  negotiation?: NegotiationPolicy;
}

// ─── Client ────────────────────────────────────────────────────────────────────

export interface AgentClientConfig {
  chain: ChainKey;
  wallet: string;
  privateKey?: string;
  reputation?: { minScore?: number };
  delegation?: DelegationConfig;
  autoSession?: boolean;
  maxBudget?: number;
}

// ─── Reputation Router ─────────────────────────────────────────────────────────

export type RoutingStrategy = 'cheapest' | 'fastest' | 'highest-reputation' | 'balanced';

export interface ProviderCandidate {
  url: string;
  agentId?: bigint;
  reputation: number;
  price: number;
  latencyMs?: number;
}

export interface RouterConfig {
  strategy?: RoutingStrategy;
  cacheTtlMs?: number;
  minReputation?: number;
}
