import { describe, it, expect } from 'vitest';
import {
  PricingEngine, DemandStrategy, ReputationStrategy, OutcomeStrategy,
  SessionManager, PaymentNegotiator, ReputationRouter, DelegationManager,
  AgentProvider, paidTool, AgentCard,
} from '../src/agent/index.js';

// ─── PricingEngine ───────────────────────────────────────────────────────────

describe('PricingEngine', () => {
  it('returns basePrice with no strategies', () => {
    const engine = new PricingEngine({ basePrice: 10000 });
    expect(engine.resolve({ toolName: 'test', basePrice: 10000 })).toBe(10000);
  });

  it('clamps to min/max when strategies active', () => {
    const engine = new PricingEngine({
      basePrice: 100, min: 500, max: 2000,
      strategies: [new ReputationStrategy()], // returns basePrice for mid-rep
    });
    expect(engine.resolve({ toolName: 'test', basePrice: 100, callerReputation: 50 })).toBe(500);
  });

  it('ReputationStrategy gives discount for high rep', () => {
    const s = new ReputationStrategy({ discountAbove: 80, discount: 0.7 });
    expect(s.resolve({ toolName: 'x', basePrice: 10000, callerReputation: 90 })).toBe(7000);
  });

  it('ReputationStrategy charges premium for low rep', () => {
    const s = new ReputationStrategy({ premiumBelow: 20, premium: 1.5 });
    expect(s.resolve({ toolName: 'x', basePrice: 10000, callerReputation: 10 })).toBe(15000);
  });

  it('OutcomeStrategy calculates bonus', () => {
    const s = new OutcomeStrategy({ bonusPercent: 25 });
    expect(s.calculateBonus(10000)).toBe(2500);
  });
});

// ─── SessionManager ──────────────────────────────────────────────────────────

describe('SessionManager', () => {
  it('creates and charges session', () => {
    const sm = new SessionManager({ defaultBudget: 100000 });
    const s = sm.create('0xCaller', '0xProvider', 'base-sepolia');
    expect(s.status).toBe('active');
    expect(sm.charge(s.id, 50000)).toBe(true);
    expect(sm.charge(s.id, 60000)).toBe(false); // over budget
  });

  it('detects settle threshold', () => {
    const sm = new SessionManager({ defaultBudget: 100, settleThreshold: 80 });
    const s = sm.create('0xA', '0xB', 'base-sepolia');
    sm.charge(s.id, 80);
    expect(sm.shouldSettle(s.id)).toBe(true);
  });

  it('settles session', () => {
    const sm = new SessionManager({ defaultBudget: 100 });
    const s = sm.create('0xA', '0xB', 'base-sepolia');
    const settled = sm.settle(s.id);
    expect(settled?.status).toBe('settled');
    expect(sm.charge(s.id, 10)).toBe(false); // can't charge settled
  });
});

// ─── PaymentNegotiator ───────────────────────────────────────────────────────

describe('PaymentNegotiator', () => {
  const neg = new PaymentNegotiator({ creditThreshold: 80, escrowThreshold: 50000 });

  it('offers credit for high reputation', () => {
    expect(neg.negotiate(10000, 90).terms).toBe('credit');
  });

  it('requires escrow for high value + low rep', () => {
    expect(neg.negotiate(100000, 50).terms).toBe('escrow');
  });

  it('defaults to direct for low value', () => {
    expect(neg.negotiate(1000, 50).terms).toBe('direct');
  });
});

// ─── ReputationRouter ────────────────────────────────────────────────────────

describe('ReputationRouter', () => {
  const candidates = [
    { url: 'http://a.com', reputation: 90, price: 20000, latencyMs: 100 },
    { url: 'http://b.com', reputation: 50, price: 5000, latencyMs: 200 },
    { url: 'http://c.com', reputation: 70, price: 10000, latencyMs: 50 },
  ];

  it('selects cheapest', () => {
    const r = new ReputationRouter({ strategy: 'cheapest' });
    expect(r.select(candidates)?.url).toBe('http://b.com');
  });

  it('selects fastest', () => {
    const r = new ReputationRouter({ strategy: 'fastest' });
    expect(r.select(candidates)?.url).toBe('http://c.com');
  });

  it('selects highest reputation', () => {
    const r = new ReputationRouter({ strategy: 'highest-reputation' });
    expect(r.select(candidates)?.url).toBe('http://a.com');
  });

  it('filters by min reputation', () => {
    const r = new ReputationRouter({ minReputation: 60 });
    const ranked = r.rank(candidates);
    expect(ranked.every(c => c.reputation >= 60)).toBe(true);
  });
});

// ─── DelegationManager ───────────────────────────────────────────────────────

describe('DelegationManager', () => {
  it('creates root and delegates', () => {
    const dm = new DelegationManager({ maxDepth: 3, maxPerHopPercent: 80 });
    const root = dm.createRoot(100000, 'base-sepolia');
    expect(root.depth).toBe(0);
    expect(root.remainingBudget).toBe(100000);

    const child = dm.delegate(root, 50000);
    expect(child.depth).toBe(1);
    expect(root.remainingBudget).toBe(50000);
  });

  it('rejects over-budget delegation', () => {
    const dm = new DelegationManager({ maxPerHopPercent: 50 });
    const root = dm.createRoot(100000, 'base-sepolia');
    expect(() => dm.delegate(root, 60000)).toThrow('exceeds max per-hop');
  });

  it('rejects max depth exceeded', () => {
    const dm = new DelegationManager({ maxDepth: 1 });
    const root = dm.createRoot(100000, 'base-sepolia');
    const child = dm.delegate(root, 50000);
    expect(() => dm.delegate(child, 10000)).toThrow('Max delegation depth');
  });

  it('tracks spending', () => {
    const dm = new DelegationManager();
    const root = dm.createRoot(1000, 'base-sepolia');
    expect(dm.spend(root, 500)).toBe(true);
    expect(dm.spend(root, 600)).toBe(false);
  });
});

// ─── AgentProvider ───────────────────────────────────────────────────────────

describe('AgentProvider', () => {
  const provider = new AgentProvider({
    name: 'TestAgent',
    description: 'Test',
    payTo: '0xProvider',
    chain: 'base-sepolia',
    tools: [paidTool({
      name: 'weather',
      description: 'Get weather',
      price: 10000,
      handler: async (input) => ({ temp: 22, city: input?.city ?? 'Tokyo' }),
    })],
  });

  it('returns tool catalog with pricing', () => {
    const catalog = provider.getToolCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].name).toBe('weather');
    expect(catalog[0]['x-x402'].price).toBe(10000);
  });

  it('middleware returns 402 without payment', () => {
    const mw = provider.middleware();
    const res: any = {
      _status: 0, _body: null, _headers: {} as Record<string, string>,
      status(c: number) { this._status = c; return this; },
      json(b: any) { this._body = b; },
      setHeader(k: string, v: string) { this._headers[k] = v; },
    };
    mw({ method: 'POST', path: '/tools/call/weather', headers: {}, body: { city: 'NYC' } } as any, res, () => {});
    expect(res._status).toBe(402);
    expect(res._headers['payment-required']).toBeDefined();
  });

  it('middleware executes tool with payment proof', async () => {
    const mw = provider.middleware();
    const res: any = {
      _status: 0, _body: null, _headers: {} as Record<string, string>,
      status(c: number) { this._status = c; return this; },
      json(b: any) { this._body = b; },
      setHeader(k: string, v: string) { this._headers[k] = v; },
    };
    mw(
      { method: 'POST', path: '/tools/call/weather', headers: { 'x-payment-tx': '0xabc' }, body: { city: 'Paris' } } as any,
      res, () => {},
    );
    // async handler — wait a tick
    await new Promise(r => setTimeout(r, 10));
    expect(res._status).toBe(200);
    expect(res._body.result.city).toBe('Paris');
  });
});

// ─── AgentCard ───────────────────────────────────────────────────────────────

describe('AgentCard', () => {
  it('generates from provider config', () => {
    const card = AgentCard.fromProvider({
      name: 'WeatherBot',
      description: 'Weather service',
      payTo: '0xPay',
      chain: 'base-sepolia',
      tools: [{ name: 'forecast', description: 'Get forecast', price: 5000, handler: async () => ({}) }],
    }, 'https://weather.bot');

    const json = card.toJSON();
    expect(json.version).toBe('1.0');
    expect(json.name).toBe('WeatherBot');
    expect(json.skills).toHaveLength(1);
    expect(json.skills[0].price).toBe(5000);
    expect(json.protocols).toContain('x402');
    expect(json.protocols).toContain('a2a');
  });
});
