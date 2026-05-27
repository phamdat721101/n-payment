import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AgentProviderConfig, ToolCallContext } from './types.js';
import { AgentProvider } from './paid-tool.js';

// Re-export `paidTool` so `n-payment/mcp` is self-contained — users can
// import the tool factory and the server factory from the same path.
export { paidTool } from './paid-tool.js';
export type { ToolCallResult, PaymentEnvelope } from './paid-tool.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for a paid MCP server. Extends `AgentProviderConfig` with
 * server-info metadata surfaced through the MCP `initialize` handshake.
 */
export interface McpServerConfig extends AgentProviderConfig {
  serverInfo?: {
    name?: string;
    version?: string;
  };
}

/** MCP protocol version this server implements. Pinned to avoid spec churn surprises. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC error codes (per spec) + one custom code for paid-tool 402.
const JSONRPC_PARSE_ERROR      = -32700;
const JSONRPC_INVALID_REQUEST  = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS   = -32602;
const JSONRPC_INTERNAL_ERROR   = -32603;
/** Custom code: payment required. Mirrors HTTP 402. `data.paymentRequired` carries the x402 envelope. */
export const JSONRPC_PAYMENT_REQUIRED = -32402;

// ─── McpServer ───────────────────────────────────────────────────────────────

/**
 * Streamable-HTTP MCP server that wraps an `AgentProvider`.
 *
 * Exposes the `2025-11-25` MCP method set — `initialize`, `tools/list`,
 * `tools/call`, `ping`, plus the standard `notifications/initialized`. 402
 * surfaces as JSON-RPC error `-32402` with `data.paymentRequired` carrying the
 * base64 x402 envelope, so MCP clients (Base MCP, AWS Bedrock AgentCore, Claude
 * Desktop, Cursor) can route the challenge through their wallet and replay the
 * call.
 *
 * SOLID:
 * - Single Responsibility: this class owns the MCP wire format only. Tool
 *   execution + 402 issuance live in `AgentProvider` and are reused unchanged.
 * - Open-Closed: adding methods (e.g. `resources/list`) is one switch case;
 *   the rest of the class is untouched.
 * - Dependency Inversion: depends on `AgentProvider`'s public surface, not its
 *   internals. Trivial to swap a different provider.
 */
export class McpServer {
  private provider: AgentProvider;
  private serverInfo: { name: string; version: string };

  constructor(config: McpServerConfig) {
    this.provider = new AgentProvider(config);
    this.serverInfo = {
      name: config.serverInfo?.name ?? config.name,
      version: config.serverInfo?.version ?? '1.0.0',
    };
  }

  /** Underlying provider — useful for tests, audit hooks, or shared catalog rendering. */
  getProvider(): AgentProvider {
    return this.provider;
  }

  /** Fetch-API request handler. Runtime-agnostic (Cloudflare Workers, Deno, Bun, Node). */
  async handle(req: Request): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonRpcResponse({ id: null, error: { code: JSONRPC_PARSE_ERROR, message: 'Parse error' } });
    }

    // Handle batch and single requests uniformly per JSON-RPC 2.0 spec.
    const requests = Array.isArray(body) ? body : [body];
    const responses: JsonRpcResponse[] = [];
    for (const r of requests) {
      const resp = await this.dispatch(r as JsonRpcRequest);
      if (resp) responses.push(resp); // notifications get no response
    }

    if (responses.length === 0) return new Response(null, { status: 204 });
    const payload = Array.isArray(body) ? responses : responses[0];
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  }

  /** Express-compatible middleware. Mounts at any path; one `app.use(server.toExpressMiddleware())`. */
  toExpressMiddleware() {
    return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
      // `express.json()` is expected upstream; if absent, fall back to raw stream.
      const body = req.body ?? (await readJson(req));
      const fakeReq = new Request('http://mcp.local', {
        method: req.method ?? 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      });
      const out = await this.handle(fakeReq);
      res.statusCode = out.status;
      out.headers.forEach((v, k) => res.setHeader(k, v));
      const text = await out.text();
      res.end(text);
    };
  }

  /** Start a standalone Node HTTP server. Returns the server so callers can `.close()` it. */
  listen(port: number, host = '0.0.0.0'): Promise<Server> {
    return import('node:http').then(({ createServer }) => {
      const server = createServer(async (req, res) => {
        try {
          const body = await readJson(req);
          const fakeReq = new Request('http://mcp.local', {
            method: req.method ?? 'POST',
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
          });
          const out = await this.handle(fakeReq);
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(await out.text());
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return new Promise<Server>((resolve) => server.listen(port, host, () => resolve(server)));
    });
  }

  // ── Internal: dispatch one JSON-RPC request to the right handler ──────────

  private async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid request' } };
    }
    // Notifications (no `id`) — execute side-effects but return no response.
    const isNotification = req.id === undefined || req.id === null;

    try {
      switch (req.method) {
        case 'initialize':
          return ok(req.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: this.serverInfo,
          });

        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null; // notifications

        case 'ping':
          return ok(req.id, {});

        case 'tools/list':
          return ok(req.id, { tools: this.toolsListShape() });

        case 'tools/call':
          return await this.handleToolsCall(req);

        default:
          if (isNotification) return null;
          return err(req.id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
      }
    } catch (e) {
      return err(req.id, JSONRPC_INTERNAL_ERROR, (e as Error).message);
    }
  }

  /** MCP `tools/list` shape — wraps the provider's catalog into the `_meta.x-x402` annotation. */
  private toolsListShape() {
    return this.provider.getToolCatalog().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', ...(t.inputSchema as Record<string, unknown>) },
      _meta: { 'x-x402': t['x-x402'] },
    }));
  }

  private async handleToolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params ?? {};
    const name = params.name as string | undefined;
    if (!name) return err(req.id, JSONRPC_INVALID_PARAMS, 'Missing tool name');

    const ctx: ToolCallContext = {
      callerAddress: (params._meta?.callerAddress as string) ?? '',
      sessionId: params._meta?.sessionId as string | undefined,
      paymentTx: params._meta?.payment as string | undefined,
    };

    const result = await this.provider.handleToolCall(name, params.arguments ?? {}, ctx);

    if (result.status === 200) {
      const body = result.body as { result: unknown };
      return ok(req.id, {
        content: [{ type: 'text', text: typeof body.result === 'string' ? body.result : JSON.stringify(body.result) }],
        structuredContent: body.result,
        isError: false,
      });
    }
    if (result.status === 402) {
      const body = result.body as { tool: string; price: number; envelope: unknown };
      return err(req.id, JSONRPC_PAYMENT_REQUIRED, 'Payment required', {
        tool: body.tool,
        price: body.price,
        paymentRequired: result.headers?.['payment-required'],
        envelope: body.envelope,
      });
    }
    if (result.status === 404) {
      return err(req.id, JSONRPC_INVALID_PARAMS, (result.body as { error: string }).error);
    }
    // 500 / unknown
    return err(req.id, JSONRPC_INTERNAL_ERROR, (result.body as { error?: string }).error ?? 'Tool execution failed');
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function err(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}
function jsonRpcResponse(payload: { id: JsonRpcRequest['id']; error: NonNullable<JsonRpcResponse['error']> }): Response {
  const body = { jsonrpc: '2.0' as const, id: payload.id ?? null, error: payload.error };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── Public factory ──────────────────────────────────────────────────────────

export function createPaidMcpServer(config: McpServerConfig): McpServer {
  return new McpServer(config);
}
