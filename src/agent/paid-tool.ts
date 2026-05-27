import type { PaidToolDef, AgentProviderConfig, ToolCallContext, PricingConfig } from './types.js';
import { PricingEngine } from './pricing.js';
import { SessionManager } from './session.js';
import { PaymentNegotiator } from './negotiator.js';
import { CHAINS } from '../chains.js';

type Req = { method: string; path: string; headers: Record<string, any>; body?: any };
type Res = { status(code: number): Res; json(body: any): void; setHeader(name: string, value: string): void };
type Next = () => void;

/**
 * Transport-agnostic outcome of a paid-tool invocation. Map this onto your
 * transport (Express HTTP, MCP JSON-RPC, etc.) — never throws for normal flow.
 *
 * - 200: handler executed successfully; body = { result: TOutput }
 * - 402: payment required; headers['payment-required'] = base64 x402 v2 envelope
 * - 404: unknown tool name
 * - 500: handler threw; body = { error: string }
 */
export interface ToolCallResult {
  status: 200 | 402 | 404 | 500;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PaymentEnvelope {
  envelope: {
    x402Version: 2;
    accepts: Array<{ scheme: 'exact'; network: string; maxAmountRequired: string; asset: string; payTo: string }>;
  };
  encoded: string;
  price: number;
}

/** Create a paid tool definition (MCP-compatible). Identity helper for inference. */
export function paidTool<TIn = any, TOut = any>(def: PaidToolDef<TIn, TOut>): PaidToolDef<TIn, TOut> {
  return def;
}

/**
 * Agent Provider — serves paid tools with x402 gating.
 *
 * Built around one transport-agnostic execution path (`handleToolCall`) so that
 * Express middleware, MCP servers, and any future transport share identical
 * 402-issuance, payment-acceptance, and tool-execution semantics. Single
 * Responsibility: this class owns the *paid tool* lifecycle. Transports are
 * thin adapters that translate `ToolCallResult` into their wire format.
 */
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

  /** Get tool catalog with `x-x402` pricing metadata (MCP / A2A discovery shape). */
  getToolCatalog() {
    return [...this.tools.values()].map((t) => ({
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

  /** Build the base64 x402 v2 PAYMENT-REQUIRED envelope for a tool's 402 challenge. */
  buildPaymentEnvelope(toolName: string, callerAddress?: string): PaymentEnvelope {
    const price = this.resolvePrice(toolName, callerAddress);
    const chain = CHAINS[this.config.chain];
    const asset = chain.tokens.USDC ?? Object.values(chain.tokens)[0]!;
    const accept = {
      scheme: 'exact' as const,
      network: chain.caip2,
      maxAmountRequired: String(price),
      asset,
      payTo: this.config.payTo,
    };
    const envelope = { x402Version: 2 as const, accepts: [accept] };
    return {
      envelope,
      encoded: Buffer.from(JSON.stringify(envelope)).toString('base64'),
      price,
    };
  }

  /** Transport-agnostic tool invocation. Returns structured 200/402/404/500. */
  async handleToolCall(name: string, input: unknown, ctx: ToolCallContext): Promise<ToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) return { status: 404, body: { error: `Unknown tool: ${name}` } };

    // Session-based payment first (cheapest verification)
    if (ctx.sessionId && this.sessions) {
      const price = this.resolvePrice(name, ctx.callerAddress);
      if (this.sessions.charge(ctx.sessionId, price)) return this.runHandler(tool, input, ctx);
    }

    // Then x402 payment proof
    if (ctx.paymentTx) return this.runHandler(tool, input, ctx);

    // Otherwise — 402 with envelope
    const { envelope, encoded, price } = this.buildPaymentEnvelope(name, ctx.callerAddress);
    return {
      status: 402,
      body: { error: 'Payment required', tool: name, price, envelope },
      headers: { 'payment-required': encoded },
    };
  }

  /** Express middleware — preserves the original synchronous 402 path for back-compat. */
  middleware() {
    return (req: Req, res: Res, next: Next) => {
      // Catalog endpoints
      if (req.path === '/tools/list' || req.path === '/.well-known/tools') {
        return res.status(200).json({ tools: this.getToolCatalog() });
      }
      if (req.method !== 'POST' || !req.path.startsWith('/tools/call')) return next();

      const toolName = req.body?.name ?? req.path.split('/').pop();
      if (!toolName || !this.tools.has(toolName)) return next();

      const ctx: ToolCallContext = {
        callerAddress: (req.headers['x-caller-address'] as string) ?? '',
        sessionId: req.headers['x-session-id'] as string | undefined,
        paymentTx: (req.headers['x-payment-tx'] as string | undefined)
          ?? (req.headers['payment-signature'] as string | undefined),
      };
      const input = req.body?.input ?? req.body;

      // Sync fast-path: no payment proof and no session → return 402 immediately.
      if (!ctx.paymentTx && !(ctx.sessionId && this.sessions)) {
        const { encoded, price } = this.buildPaymentEnvelope(toolName, ctx.callerAddress);
        res.setHeader('payment-required', encoded);
        return res.status(402).json({ error: 'Payment required', tool: toolName, price });
      }

      // Async path: handler execution (or session-charge fallback to 402).
      void this.handleToolCall(toolName, input, ctx).then((result) => {
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        }
        res.status(result.status).json(result.body);
      });
    };
  }

  private resolvePrice(toolName: string, callerAddress?: string): number {
    const engine = this.pricingEngines.get(toolName);
    const tool = this.tools.get(toolName);
    if (!engine || !tool) return 0;
    const basePrice = typeof tool.price === 'number' ? tool.price : tool.price.basePrice;
    return engine.resolve({ toolName, callerAddress, basePrice });
  }

  private async runHandler(tool: PaidToolDef, input: unknown, ctx: ToolCallContext): Promise<ToolCallResult> {
    try {
      const result = await tool.handler(input, ctx);
      return { status: 200, body: { result } };
    } catch (err) {
      return { status: 500, body: { error: (err as Error).message } };
    }
  }
}

export function createAgentProvider(config: AgentProviderConfig): AgentProvider {
  return new AgentProvider(config);
}
