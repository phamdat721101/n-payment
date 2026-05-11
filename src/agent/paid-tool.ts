import type { PaidToolDef, AgentProviderConfig, ToolCallContext, PricingConfig, PricingContext } from './types.js';
import { PricingEngine } from './pricing.js';
import { SessionManager } from './session.js';
import { PaymentNegotiator } from './negotiator.js';
import { CHAINS } from '../chains.js';

type Req = { method: string; path: string; headers: Record<string, any>; body?: any };
type Res = { status(code: number): Res; json(body: any): void; setHeader(name: string, value: string): void };
type Next = () => void;

/** Create a paid tool definition (MCP-compatible) */
export function paidTool<TIn = any, TOut = any>(def: PaidToolDef<TIn, TOut>): PaidToolDef<TIn, TOut> {
  return def;
}

/** Agent Provider — serves paid tools via HTTP with x402 gating */
export class AgentProvider {
  private tools = new Map<string, PaidToolDef>();
  private pricingEngines = new Map<string, PricingEngine>();
  private sessions: SessionManager | undefined;
  private negotiator: PaymentNegotiator;
  private config: AgentProviderConfig;

  constructor(config: AgentProviderConfig) {
    this.config = config;
    this.negotiator = new PaymentNegotiator(config.negotiation);
    if (config.sessions) this.sessions = new SessionManager(config.sessions);

    for (const tool of config.tools) {
      this.tools.set(tool.name, tool);
      const pc: PricingConfig = typeof tool.price === 'number'
        ? { basePrice: tool.price, ...(config.pricing ?? {}) }
        : { ...(config.pricing ?? {}), ...tool.price };
      this.pricingEngines.set(tool.name, new PricingEngine(pc));
    }
  }

  /** Express middleware — gates tool calls with x402 payment */
  middleware() {
    return (req: Req, res: Res, next: Next) => {
      // tools/list endpoint — return tool catalog with pricing
      if (req.path === '/tools/list' || req.path === '/.well-known/tools') {
        return res.status(200).json({ tools: this.getToolCatalog() });
      }

      // tools/call endpoint
      if (req.method !== 'POST' || !req.path.startsWith('/tools/call')) return next();

      const toolName = req.body?.name ?? req.path.split('/').pop();
      const tool = this.tools.get(toolName!);
      if (!tool) return next();

      // Check session-based payment
      const sessionId = req.headers['x-session-id'] as string | undefined;
      if (sessionId && this.sessions) {
        const price = this.resolvePrice(toolName!, req.headers['x-caller-address']);
        if (this.sessions.charge(sessionId, price)) {
          return this.executeTool(tool, req, res, { callerAddress: req.headers['x-caller-address'] ?? '', sessionId });
        }
      }

      // Check x402 payment proof
      if (req.headers['x-payment-tx'] || req.headers['payment-signature']) {
        const ctx: ToolCallContext = {
          callerAddress: req.headers['x-caller-address'] ?? '',
          paymentTx: req.headers['x-payment-tx'],
        };
        return this.executeTool(tool, req, res, ctx);
      }

      // No payment — return 402 with payment envelope
      const price = this.resolvePrice(toolName!, req.headers['x-caller-address']);
      const chain = CHAINS[this.config.chain];
      const envelope = {
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: chain.caip2,
          maxAmountRequired: String(price),
          asset: chain.tokens.USDC ?? Object.values(chain.tokens)[0],
          payTo: this.config.payTo,
        }],
      };
      res.setHeader('payment-required', Buffer.from(JSON.stringify(envelope)).toString('base64'));
      res.status(402).json({ error: 'Payment required', tool: toolName, price });
    };
  }

  /** Get tool catalog with pricing metadata */
  getToolCatalog() {
    return [...this.tools.values()].map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? {},
      'x-x402': {
        price: typeof t.price === 'number' ? t.price : t.price.basePrice,
        chain: this.config.chain,
        payTo: this.config.payTo,
      },
    }));
  }

  private resolvePrice(toolName: string, callerAddress?: string): number {
    const engine = this.pricingEngines.get(toolName);
    const tool = this.tools.get(toolName);
    if (!engine || !tool) return 0;
    const basePrice = typeof tool.price === 'number' ? tool.price : tool.price.basePrice;
    return engine.resolve({ toolName, callerAddress, basePrice });
  }

  private async executeTool(tool: PaidToolDef, req: Req, res: Res, ctx: ToolCallContext) {
    try {
      const result = await tool.handler(req.body?.input ?? req.body, ctx);
      res.status(200).json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}

export function createAgentProvider(config: AgentProviderConfig): AgentProvider {
  return new AgentProvider(config);
}
