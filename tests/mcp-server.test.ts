import { describe, it, expect } from 'vitest';
import {
  createPaidMcpServer, paidTool, MCP_PROTOCOL_VERSION, JSONRPC_PAYMENT_REQUIRED,
} from '../src/agent/index.js';

const baseConfig = {
  name: 'WeatherBot',
  description: 'Weather data for AI agents',
  payTo: '0xPay0000000000000000000000000000000000000' as const,
  chain: 'base-mainnet' as const,
  tools: [
    paidTool({
      name: 'forecast',
      description: 'Weather forecast for a city',
      price: 10000,
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      handler: async (input: any) => ({ city: input.city, temp: 22 }),
    }),
    paidTool({
      name: 'errorTool',
      description: 'Always throws',
      price: 1000,
      handler: async () => { throw new Error('boom'); },
    }),
  ],
};

const rpc = (method: string, id: number | string | null = 1, params?: unknown) =>
  new Request('http://mcp.local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

const decode = async (res: Response) => {
  expect(res.headers.get('content-type')).toContain('application/json');
  return JSON.parse(await res.text());
};

// ─── Spec compliance ─────────────────────────────────────────────────────────

describe('McpServer — spec compliance (MCP 2025-11-25)', () => {
  const server = createPaidMcpServer(baseConfig);

  it('initialize returns the protocol version + capabilities + serverInfo', async () => {
    const body = await decode(await server.handle(rpc('initialize')));
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe('WeatherBot');
  });

  it('ping returns empty result', async () => {
    const body = await decode(await server.handle(rpc('ping', 2)));
    expect(body.result).toEqual({});
  });

  it('tools/list returns each paidTool with _meta.x-x402 metadata', async () => {
    const body = await decode(await server.handle(rpc('tools/list', 3)));
    expect(body.result.tools).toHaveLength(2);
    const forecast = body.result.tools.find((t: any) => t.name === 'forecast');
    expect(forecast.description).toMatch(/forecast/i);
    expect(forecast._meta['x-x402'].price).toBe(10000);
    expect(forecast._meta['x-x402'].chain).toBe('base-mainnet');
    expect(forecast._meta['x-x402'].payTo).toBe(baseConfig.payTo);
  });

  it('notifications/initialized is silent (no response)', async () => {
    // No id → notification per spec.
    const req = new Request('http://mcp.local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    const res = await server.handle(req);
    expect(res.status).toBe(204);
  });
});

// ─── Payment-required surface ────────────────────────────────────────────────

describe('McpServer — 402 / payment surface', () => {
  const server = createPaidMcpServer(baseConfig);

  it('tools/call without payment returns -32402 with paymentRequired data', async () => {
    const body = await decode(await server.handle(rpc('tools/call', 10, {
      name: 'forecast',
      arguments: { city: 'Tokyo' },
    })));
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(JSONRPC_PAYMENT_REQUIRED);
    expect(body.error.message).toMatch(/payment required/i);
    expect(body.error.data.tool).toBe('forecast');
    expect(body.error.data.price).toBe(10000);
    // paymentRequired should decode to an x402 v2 envelope
    const decoded = JSON.parse(Buffer.from(body.error.data.paymentRequired, 'base64').toString());
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts[0].scheme).toBe('exact');
    expect(decoded.accepts[0].network).toBe('eip155:8453');
    expect(decoded.accepts[0].maxAmountRequired).toBe('10000');
    expect(decoded.accepts[0].payTo).toBe(baseConfig.payTo);
  });

  it('tools/call with payment header succeeds and returns structured + text content', async () => {
    const body = await decode(await server.handle(rpc('tools/call', 11, {
      name: 'forecast',
      arguments: { city: 'Paris' },
      _meta: { payment: 'eyAib2siOiJ0cnVlIiB9' /* arbitrary base64 — adapter only checks presence */ },
    })));
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toEqual({ city: 'Paris', temp: 22 });
    expect(body.result.content[0].type).toBe('text');
    expect(JSON.parse(body.result.content[0].text)).toEqual({ city: 'Paris', temp: 22 });
  });

  it('tools/call propagates handler errors as -32603', async () => {
    const body = await decode(await server.handle(rpc('tools/call', 12, {
      name: 'errorTool',
      arguments: {},
      _meta: { payment: 'paid' },
    })));
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toMatch(/boom/);
  });
});

// ─── Error mapping ───────────────────────────────────────────────────────────

describe('McpServer — JSON-RPC error mapping', () => {
  const server = createPaidMcpServer(baseConfig);

  it('unknown method returns -32601', async () => {
    const body = await decode(await server.handle(rpc('does/not/exist', 20)));
    expect(body.error.code).toBe(-32601);
  });

  it('missing tool name returns -32602', async () => {
    const body = await decode(await server.handle(rpc('tools/call', 21, { arguments: {} })));
    expect(body.error.code).toBe(-32602);
  });

  it('unknown tool name returns -32602', async () => {
    const body = await decode(await server.handle(rpc('tools/call', 22, { name: 'nope', arguments: {} })));
    expect(body.error.code).toBe(-32602);
  });

  it('malformed JSON body returns -32700', async () => {
    const req = new Request('http://mcp.local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const body = await decode(await server.handle(req));
    expect(body.error.code).toBe(-32700);
  });

  it('non-2.0 jsonrpc returns -32600', async () => {
    const req = new Request('http://mcp.local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }),
    });
    const body = await decode(await server.handle(req));
    expect(body.error.code).toBe(-32600);
  });

  it('rejects non-POST with 405', async () => {
    const res = await server.handle(new Request('http://mcp.local', { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});

// ─── Batch ───────────────────────────────────────────────────────────────────

describe('McpServer — JSON-RPC batch', () => {
  const server = createPaidMcpServer(baseConfig);

  it('handles batch of mixed methods', async () => {
    const req = new Request('http://mcp.local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]),
    });
    const body = await decode(await server.handle(req));
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(1);
    expect(body[1].result.tools).toHaveLength(2);
  });
});
