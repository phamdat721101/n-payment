import type { AgentClientConfig, ProviderCandidate, DelegationContext, NegotiationResult } from './types.js';
import type { NPaymentConfig } from '../types.js';
import { PaymentClient } from '../client.js';
import { BazaarClient } from '../bazaar/client.js';
import { ReputationRouter } from './reputation-router.js';
import { SessionManager } from './session.js';
import { DelegationManager } from './delegation.js';
import { PaymentNegotiator } from './negotiator.js';

export class AgentClient {
  private paymentClient: PaymentClient;
  private bazaar: BazaarClient;
  private router: ReputationRouter;
  private sessions: SessionManager;
  private delegation: DelegationManager;
  private negotiator: PaymentNegotiator;
  private config: AgentClientConfig;

  constructor(config: AgentClientConfig) {
    this.config = config;
    this.paymentClient = new PaymentClient({
      chains: [config.chain],
      ows: { wallet: config.wallet, privateKey: config.privateKey },
    });
    this.bazaar = new BazaarClient({ mockCatalog: true });
    this.router = new ReputationRouter(config.reputation ? { minReputation: config.reputation.minScore } : {});
    this.sessions = new SessionManager({ defaultBudget: config.maxBudget ?? 1_000_000 });
    this.delegation = new DelegationManager(config.delegation);
    this.negotiator = new PaymentNegotiator();
  }

  /** Discover services matching a query */
  async discover(query: string): Promise<ProviderCandidate[]> {
    const { resources } = await this.bazaar.search(query);
    return resources.map(r => ({
      url: r.resource,
      reputation: 50, // default; real impl queries ERC-8004
      price: Number(r.accepts[0]?.maxAmountRequired ?? 0),
    }));
  }

  /** Select best provider from candidates */
  selectProvider(candidates: ProviderCandidate[]): ProviderCandidate | undefined {
    return this.router.select(candidates);
  }

  /** Negotiate payment terms with a provider */
  negotiate(price: number, callerReputation: number): NegotiationResult {
    return this.negotiator.negotiate(price, callerReputation);
  }

  /** Make a paid call to a provider URL */
  async call(url: string, opts?: { input?: any; delegationCtx?: DelegationContext }): Promise<any> {
    const headers: Record<string, string> = {};
    if (opts?.delegationCtx) {
      headers['x-delegation-root'] = opts.delegationCtx.rootId;
      headers['x-delegation-depth'] = String(opts.delegationCtx.depth);
      headers['x-delegation-budget'] = String(opts.delegationCtx.remainingBudget);
    }

    const response = await this.paymentClient.fetchWithPayment(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: opts?.input ? JSON.stringify({ input: opts.input }) : undefined,
    });
    return response.json();
  }

  /** Create a delegation context for multi-agent workflows */
  createDelegation(budget: number): DelegationContext {
    return this.delegation.createRoot(budget, this.config.chain);
  }

  /** Sub-delegate budget to a child task */
  delegate(parent: DelegationContext, amount: number): DelegationContext {
    return this.delegation.delegate(parent, amount);
  }

  /** Full flow: discover → select → call */
  async discoverAndCall(query: string, input?: any): Promise<any> {
    const candidates = await this.discover(query);
    const provider = this.selectProvider(candidates);
    if (!provider) throw new Error(`No provider found for: ${query}`);
    return this.call(provider.url, { input });
  }
}

export function createAgentClient(config: AgentClientConfig): AgentClient {
  return new AgentClient(config);
}
