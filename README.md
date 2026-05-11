# n-payment

Multi-protocol payment SDK for Web3 agents. Unifies [x402](https://x402.org), [MPP](https://mpp.dev), and [GOAT x402](https://docs.goat.network/builders/x402) behind a single `fetchWithPayment()` call — secured by the [Open Wallet Standard (OWS)](https://docs.openwallet.sh).

**Private keys never leave the OWS vault.** Every transaction is policy-gated.

[![npm](https://img.shields.io/npm/v/n-payment)](https://www.npmjs.com/package/n-payment)

## Install

```bash
npm install n-payment
```

## What's New in v0.5 — Agent Commerce

n-payment is now a **full three-layer agent commerce SDK** supporting the MCP + A2A + x402 stack:

- **Agent as Consumer** — discover, negotiate, pay for services automatically
- **Agent as Provider** — expose paid tools with dynamic pricing and x402 gating
- **Multi-Agent Orchestration** — delegation chains, budget tracking, reputation routing

```
┌─────────────────────────────────────────────────────────────────┐
│                    n-payment v0.5                                │
├─────────────────────────────────────────────────────────────────┤
│  Agent Consumer          │  Agent Provider                      │
│  createAgentClient()     │  createAgentProvider()               │
│  discover → negotiate    │  paidTool() → x402 gating           │
│  → pay → feedback        │  AgentCard → A2A discovery           │
├─────────────────────────────────────────────────────────────────┤
│  PricingEngine │ SessionManager │ EscrowManager │ Delegation    │
├─────────────────────────────────────────────────────────────────┤
│  PaymentClient (x402 + MPP + GOAT) │ OWSWallet (signing)       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start — Agent Provider (Get Paid)

Expose your API as a paid service that other agents can discover and pay for:

```typescript
import express from 'express';
import { createAgentProvider, paidTool, AgentCard } from 'n-payment';

const provider = createAgentProvider({
  name: 'WeatherBot',
  description: 'Weather data for AI agents',
  payTo: '0xYourWalletAddress',
  chain: 'base-sepolia',
  tools: [
    paidTool({
      name: 'forecast',
      description: 'Get weather forecast',
      price: 10000, // 0.01 USDC
      handler: async (input) => ({ city: input.city, temp: 22 }),
    }),
  ],
});

const app = express();
app.use(express.json());
app.use(provider.middleware());
app.get('/.well-known/agent.json', AgentCard.fromProvider(provider, 'https://your-agent.com').handler());
app.listen(3000);
```

## Quick Start — Agent Consumer (Pay for Services)

Discover and pay for services with one call:

```typescript
import { createAgentClient } from 'n-payment';

const agent = createAgentClient({
  chain: 'base-sepolia',
  wallet: 'my-agent',
});

const result = await agent.discoverAndCall('weather', { city: 'Tokyo' });
// SDK handles: discover → 402 → sign payment → settle → retry → result
```

---

## How Payment Works

```
Agent Client                    Facilitator              Agent Provider
     │                              │                         │
     │  1. POST /tools/call ────────────────────────────────►│
     │                              │                         │ no payment
     │  2. ◄──────────────────────────────────────── 402 ────│
     │     payment-required: {chain, amount, payTo}           │
     │                              │                         │
     │  3. OWS signs EIP-3009       │                         │
     │                              │                         │
     │  4. verify + settle ────────►│ broadcasts on-chain     │
     │                              │                         │
     │  5. POST /tools/call + x-payment-tx ─────────────────►│
     │                              │                         │ executes tool
     │  6. ◄──────────────────────────────────── 200 + data ─│
```

**Facilitators:**
- Testnet: `https://x402.org/facilitator` (Base Sepolia)
- Production: `https://api.cdp.coinbase.com/platform/v2/x402` (Base)

---

## Agent Provider — Full Guide

### Dynamic Pricing

Adjust prices in real-time based on demand, reputation, and outcomes:

```typescript
import { paidTool, DemandStrategy, ReputationStrategy } from 'n-payment';

paidTool({
  name: 'premium-data',
  price: {
    basePrice: 10000,
    strategies: [
      new DemandStrategy({ threshold: 100, multiplier: 2 }),     // 2x at 100 req/min
      new ReputationStrategy({ discountAbove: 80, discount: 0.7 }), // 30% off for trusted
    ],
    min: 5000,
    max: 100000,
  },
  handler: async (input) => { /* ... */ },
});
```

### Session-Based Payments (MPP Vouchers)

For high-frequency calls, use sessions — one on-chain tx covers many calls:

```typescript
const provider = createAgentProvider({
  // ...
  sessions: { defaultBudget: 500000, ttlMs: 300_000, settleThreshold: 80 },
});
```

Clients send `x-session-id` header — each call deducts from the session budget with zero gas cost (off-chain voucher verification only).

### Escrow (Outcome-Based)

For high-value tasks, lock payment in ERC-8183 escrow:

```typescript
import { EscrowManager, OWSWallet } from 'n-payment';

const escrow = new EscrowManager(wallet, {
  contractAddress: '0xEscrowContract',
  evaluator: '0xEvaluatorAddress',
  chain: 'base-sepolia',
});

const job = await escrow.createJob('0xProvider', 100000);
// Provider submits work → Evaluator approves → Funds released
```

---

## Agent Consumer — Full Guide

### Step-by-Step Control

```typescript
const agent = createAgentClient({ chain: 'base-sepolia', wallet: 'my-agent' });

// 1. Discover
const candidates = await agent.discover('weather');

// 2. Select (by reputation, price, latency)
const provider = agent.selectProvider(candidates);

// 3. Negotiate terms (direct/escrow/credit based on reputation)
const terms = agent.negotiate(provider.price, 90);

// 4. Call
const result = await agent.call(provider.url, { input: { city: 'Paris' } });
```

### Multi-Agent Delegation

Orchestrate sub-agents with budget tracking:

```typescript
const delegation = agent.createDelegation(1_000_000); // $1 total

const research = agent.delegate(delegation, 500_000);
await agent.call('https://research-agent.com/tools/call/analyze', {
  input: { topic: 'BTC' },
  delegationCtx: research,
});

const data = agent.delegate(delegation, 300_000);
await agent.call('https://data-agent.com/tools/call/fetch', {
  delegationCtx: data,
});
// Remaining: $0.20 tracked automatically
```

### Reputation Routing

Select providers by trust score:

```typescript
import { ReputationRouter } from 'n-payment';

const router = new ReputationRouter({ strategy: 'balanced', minReputation: 30 });
const best = router.select(candidates);
// Weighs: reputation (40%) + price (35%) + latency (25%)
```

---

## Human Payments (Unchanged from v0.4)

### Buyer — Pay for APIs

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-sepolia'],
  ows: { wallet: 'my-agent' },
});

const response = await client.fetchWithPayment('https://api.example.com/data');
```

### Seller — Paywall Middleware

```typescript
import { createPaywall, createHealthEndpoint } from 'n-payment';

app.use(createPaywall({
  routes: {
    'GET /api/weather': {
      price: '10000',
      x402: { payTo: '0xYourAddress' },
      mpp: { currency: '0x20c0...', recipient: '0xYourAddress' },
    },
  },
}));
```

---

## OWS Wallet Setup

```bash
curl -fsSL https://docs.openwallet.sh/install.sh | bash
ows wallet create --name my-agent
ows fund deposit --wallet my-agent
```

Dev-only fallback:
```typescript
ows: { wallet: 'dev-agent', privateKey: process.env.PRIVATE_KEY }
```

---

## Supported Chains

| Chain | Key | Protocol | Chain ID |
|-------|-----|----------|----------|
| Base Sepolia | `base-sepolia` | x402 | 84532 |
| Base | `base-mainnet` | x402 | 8453 |
| Arbitrum Sepolia | `arbitrum-sepolia` | x402 | 421614 |
| GOAT Testnet | `goat-testnet` | GOAT x402 | 48816 |
| Tempo Testnet | `tempo-testnet` | MPP | 42431 |
| Tempo | `tempo-mainnet` | MPP | 4217 |

---

## API Reference

### Agent Commerce

| Export | Purpose |
|--------|---------|
| `createAgentProvider(config)` | Create agent that sells services |
| `createAgentClient(config)` | Create agent that buys services |
| `paidTool(def)` | Define a paid tool (MCP-compatible) |
| `AgentCard.fromProvider(config, url)` | Generate A2A Agent Card |
| `PricingEngine` | Composable dynamic pricing |
| `DemandStrategy` | Surge pricing by request volume |
| `ReputationStrategy` | Discount/premium by ERC-8004 score |
| `OutcomeStrategy` | Bonus for verified quality |
| `SessionManager` | Streaming micropayment sessions |
| `EscrowManager` | ERC-8183 programmable escrow |
| `PaymentNegotiator` | Auto-select direct/escrow/credit |
| `ReputationRouter` | Trust-weighted provider selection |
| `DelegationManager` | Multi-agent budget chains |

### Core

| Export | Purpose |
|--------|---------|
| `createPaymentClient(config)` | Create payment client (buyer) |
| `createPaywall(config)` | Express paywall middleware |
| `createHealthEndpoint(config)` | Health/pricing endpoint |
| `GoatIdentity` | ERC-8004 agent identity + reputation |
| `BazaarClient` | Service discovery |
| `OffRampClient` | USDC → fiat conversion |

---

## License

MIT
