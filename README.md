# n-payment

The payment layer for AI agents. One SDK, every protocol.

Unifies [x402](https://x402.org), [MPP](https://mpp.dev), [GOAT x402](https://docs.goat.network), [Stellar](https://stellar.org), [XRPL](https://xrpl.org), [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments), and [AP2](https://ap2-protocol.org) behind a single `fetchWithPayment()` call — with policy-gated spending, batch settlement, and full audit trail.

[![npm](https://img.shields.io/npm/v/n-payment)](https://www.npmjs.com/package/n-payment)

```bash
npm install n-payment
```

---

## For AI Agents — How to Use This SDK

> **If you are an AI agent reading this**, here is exactly how to pay for any API:

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
});

// That's it. Call any paid API — SDK handles 402 → pay → retry automatically.
const response = await client.fetchWithPayment('https://api.example.com/data');
const data = await response.json();
```

**What happens under the hood:**
1. SDK sends your HTTP request
2. If server returns `402 Payment Required`, SDK reads the payment challenge
3. SDK auto-detects the protocol (x402, MPP, GOAT, Stellar, Circle)
4. SDK signs and sends payment
5. SDK retries your request with payment proof
6. You get the response — no payment code needed

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         n-payment v0.8                               │
├─────────────────────────────────────────────────────────────────────┤
│  YOUR CODE: fetchWithPayment(url)                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Policy Engine → Spending Guard → Audit Log                         │
├─────────────────────────────────────────────────────────────────────┤
│  Batch Settlement │ Streaming Payments │ Circle Nanopayments        │
├─────────────────────────────────────────────────────────────────────┤
│  x402 │ MPP │ GOAT │ Stellar │ XRPL │ Solana │ Circle Gateway      │
├─────────────────────────────────────────────────────────────────────┤
│  OWS Wallet │ Viem │ Stellar Wallet │ XRPL Wallet │ Solana Keypair │
├─────────────────────────────────────────────────────────────────────┤
│  Agent Commerce: Discovery → Negotiate → Pay → Feedback             │
│  AP2 Protocol: Verifiable Intent → Checkout Mandate → Payment       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Supported Chains (13)

| Chain | Key | Protocol | Use Case |
|-------|-----|----------|----------|
| Base | `base-mainnet` | x402 | Production payments |
| Base Sepolia | `base-sepolia` | x402 | Testing |
| Arbitrum Sepolia | `arbitrum-sepolia` | x402 | Testing |
| GOAT Network | `goat-mainnet` | GOAT x402 | BTC-backed payments |
| GOAT Testnet | `goat-testnet` | GOAT x402 | Testing |
| Tempo | `tempo-mainnet` | MPP | Streaming payments |
| Tempo Testnet | `tempo-testnet` | MPP | Testing |
| Stellar Mainnet | `stellar-mainnet` | x402 + MPP | Cross-border |
| Stellar Testnet | `stellar-testnet` | x402 + MPP | Testing |
| XRPL Mainnet | `xrpl-mainnet` | XRPL | RLUSD payments |
| XRPL Testnet | `xrpl-testnet` | XRPL | Testing |
| Solana | `solana-mainnet` | x402 | High-speed payments |
| Solana Devnet | `solana-devnet` | x402 | Testing |

---

## Quick Start — Pay for APIs (Agent Consumer)

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
});

const res = await client.fetchWithPayment('https://paid-api.com/weather?city=Tokyo');
```

## Quick Start — Sell APIs (Agent Provider)

```typescript
import express from 'express';
import { createAgentProvider, paidTool, AgentCard } from 'n-payment';

const provider = createAgentProvider({
  name: 'WeatherBot',
  description: 'Weather data for AI agents',
  payTo: '0xYourAddress',
  chain: 'base-mainnet',
  tools: [
    paidTool({
      name: 'forecast',
      description: 'Get weather forecast',
      price: 10000, // $0.01 USDC
      handler: async (input) => ({ city: input.city, temp: 22 }),
    }),
  ],
});

const app = express();
app.use(express.json());
app.use(provider.middleware());
app.get('/.well-known/agent.json', AgentCard.fromProvider(provider, 'https://your-api.com').handler());
app.listen(3000);
```

## Quick Start — With Policy & Spending Limits

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
  policy: {
    maxPerTransaction: 100000n,  // Max $0.10 per call
    maxPerHour: 1000000n,        // Max $1.00 per hour
    maxPerDay: 10000000n,        // Max $10.00 per day
    rateLimit: { maxRequests: 100, windowMs: 60_000 },
    blocklist: ['0xKnownScam...'],
  },
});

// Policy automatically blocks overspending
const res = await client.fetchWithPayment(url);

// Check audit trail
const audit = client.getGuard()?.getAudit();
const summary = audit?.getSpendingSummary(); // { total: 500000n, count: 12 }
```

## Quick Start — Batch Settlement (Sub-cent Payments)

```typescript
import { BatchSettlementManager } from 'n-payment';

const batch = new BatchSettlementManager();

// Open session with budget (one on-chain tx)
const session = batch.openSession({
  chain: 'base-mainnet',
  budget: 1000000n, // $1.00 USDC
  escrowContract: '0x...',
});

// Each API call: sign offchain voucher (zero gas)
const voucher = batch.signVoucher(session.id, 100n); // $0.0001

// Seller batch-settles many vouchers in one tx later
```

## Quick Start — Streaming Payments

```typescript
import { StreamingPaymentManager } from 'n-payment';

const streaming = new StreamingPaymentManager();

const stream = streaming.createStream({
  provider: '0xProvider',
  chain: 'tempo-mainnet',
  budget: 5000000n,       // $5.00
  intervalMs: 60_000,     // Settle every minute
  maxPerInterval: 100000n, // Max $0.10/min
});

// Record usage per API call
streaming.recordUsage(stream.id, 1000n); // $0.001

// Settle accumulated usage
streaming.settleInterval(stream.id);
```

## Quick Start — Circle Nanopayments (Gas-Free)

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
  circle: {
    apiKey: process.env.CIRCLE_API_KEY,
    environment: 'production',
  },
});

// Gas-free payments down to $0.000001 via Circle Gateway
const res = await client.fetchWithPayment('https://api.example.com/data');
```

## Quick Start — AP2 Protocol (Verifiable Authorization)

```typescript
import { AP2Client, VerifiableIntentSigner } from 'n-payment';

const ap2 = new AP2Client({ agentId: 'my-agent-123' });

// User authorizes agent with constraints
const mandate = ap2.createCheckoutMandate({
  maxBudget: 5000000n,  // Agent can spend up to $5
  expiresAt: Date.now() + 3600_000,
});

// Agent shops and closes mandate with specific cart
const closed = ap2.closeCheckoutMandate(mandate.id, {
  items: [{ name: 'Weather API', price: 10000n, quantity: 1 }],
  total: 10000n,
  merchant: '0xProvider',
});

// Create payment mandate (cryptographic proof of authorization)
const payment = ap2.createPaymentMandate(closed.id, 10000n, 'x402');
```

## Quick Start — Multi-Agent Delegation

```typescript
import { createAgentClient } from 'n-payment';

const leader = createAgentClient({ chain: 'base-mainnet', wallet: 'leader-agent' });

// Leader creates budget and delegates to workers
const budget = leader.createDelegation(5000000); // $5.00
const workerBudget = leader.delegate(budget, 1000000); // $1.00 to worker

// Worker uses delegated budget
const result = await leader.call('https://api.example.com/data', {
  delegationCtx: workerBudget,
});
```

## Quick Start — Stellar + Trustless Work Escrow

```typescript
import { StellarWallet, TrustlessEscrowManager } from 'n-payment';

const wallet = new StellarWallet({ secretKey: process.env.STELLAR_SECRET });
const escrow = new TrustlessEscrowManager(wallet, { chain: 'stellar-testnet' });

const job = await escrow.createJob({
  provider: 'GPROVIDER...',
  amount: '10000000',
  title: 'AI Research Task',
  milestones: [{ description: 'Deliver analysis' }, { description: 'Final report' }],
  type: 'multi',
});

await escrow.fundJob(job.id);
await escrow.submitMilestone(job.id, 0);
await escrow.approveAndRelease(job.id, 0);
```

---

## Agent Decision Guide

| You want to... | Use this |
|----------------|----------|
| Pay for any API automatically | `createPaymentClient()` → `fetchWithPayment(url)` |
| Sell your API for crypto | `createAgentProvider()` + `paidTool()` |
| Find services to buy | `createAgentClient()` → `discover(query)` |
| Limit spending | `policy: { maxPerDay: 10000000n }` |
| Sub-cent micropayments | `BatchSettlementManager` or `circle: { apiKey }` |
| Streaming/metered billing | `StreamingPaymentManager` |
| Multi-agent budget sharing | `DelegationManager` |
| Escrow for high-value tasks | `EscrowManager` or `TrustlessEscrowManager` |
| Prove authorization (AP2) | `AP2Client` + `VerifiableIntentSigner` |
| Register on-chain identity | `GoatIdentity` → `registerAgent()` |
| Off-ramp to fiat | `OffRampClient` |
| BTC-backed payments | `BtcLendingVault` |

---

## API Reference

### Core

| Export | Purpose |
|--------|---------|
| `createPaymentClient(config)` | Create payment client (auto-detects protocol) |
| `createPaywall(config)` | Express paywall middleware |
| `createHealthEndpoint(config)` | Health/pricing endpoint |
| `detectProtocol(response)` | Detect x402 vs MPP from 402 response |

### Agent Commerce

| Export | Purpose |
|--------|---------|
| `createAgentProvider(config)` | Sell services with x402 gating |
| `createAgentClient(config)` | Buy services with discovery |
| `paidTool(def)` | Define a paid tool (MCP-compatible) |
| `AgentCard.fromProvider()` | Generate A2A Agent Card |
| `PricingEngine` | Dynamic pricing (demand/reputation/outcome) |
| `SessionManager` | Micropayment sessions |
| `EscrowManager` | ERC-8183 programmable escrow |
| `PaymentNegotiator` | Auto-select direct/escrow/credit |
| `ReputationRouter` | Trust-weighted provider selection |
| `DelegationManager` | Multi-agent budget chains |

### Settlement (v0.8)

| Export | Purpose |
|--------|---------|
| `BatchSettlementManager` | x402 batch settlement with cumulative vouchers |
| `StreamingPaymentManager` | Interval-based streaming payments |
| `Permit2Signer` | EIP-712 Permit2 for any ERC-20 token |

### Policy & Audit (v0.8)

| Export | Purpose |
|--------|---------|
| `PolicyEngine` | Spending limits, rate limits, blocklist |
| `AuditLog` | Queryable payment history |
| `SpendingGuard` | Middleware wrapping payments with policy |

### AP2 Protocol (v0.8)

| Export | Purpose |
|--------|---------|
| `AP2Client` | Google/FIDO Agent Payments Protocol |
| `VerifiableIntentSigner` | Tamper-proof agent action authorization |

### Adapters (v0.8)

| Export | Purpose |
|--------|---------|
| `CircleGatewayAdapter` | Gas-free nanopayments via Circle Gateway |
| `SolanaX402Adapter` | x402 payments on Solana |
| `StellarX402Adapter` | x402 payments on Stellar/Soroban |
| `StellarMppAdapter` | MPP payments on Stellar |
| `XrplAdapter` | RLUSD payments on XRPL |

### Wallets

| Export | Purpose |
|--------|---------|
| `OWSWallet` | Open Wallet Standard (policy-gated, multi-chain) |
| `StellarWallet` | Stellar keypair + Soroban auth |
| `XrplWallet` | XRPL wallet with trust lines |

### Stellar & Escrow

| Export | Purpose |
|--------|---------|
| `TrustlessWorkClient` | REST client for Trustless Work API |
| `TrustlessEscrowManager` | Milestone-based escrow lifecycle |

### GOAT Network

| Export | Purpose |
|--------|---------|
| `GoatIdentity` | ERC-8004 agent identity + reputation |
| `BtcLendingVault` | Lock BTC → borrow USDC |
| `GoatX402Client` | GOAT order lifecycle |

---

## Configuration Reference

```typescript
createPaymentClient({
  // Required
  chains: ['base-mainnet'],           // Which chains to use
  ows: { wallet: 'name', privateKey: '0x...' }, // Wallet config

  // Protocol preference (default: 'auto')
  protocol: 'auto',                   // 'x402' | 'mpp' | 'auto'

  // Chain-specific
  goat: { apiKey, apiSecret, merchantId }, // GOAT Network
  stellar: { secretKey },             // Stellar
  xrpl: { seed },                     // XRPL
  solana: { keypair },                // Solana

  // v0.8 features (all optional)
  circle: { apiKey, environment },    // Circle nanopayments
  policy: { maxPerTransaction, maxPerDay, rateLimit, blocklist },
  ap2: { agentId, signingKey },       // AP2 authorization
  batchSettlement: { enabled: true }, // Batch settlement
  streaming: { defaultInterval },     // Streaming payments
  x402: { usePermit2: true },         // Permit2 for any ERC-20
});
```

---

## For AI Agent Frameworks

### MCP Server (Model Context Protocol)

n-payment ships as an MCP server for tool-use agents:

```bash
# Install the agent-payment skill
npx agent-payment
```

This gives your agent 19 payment tools: pay, balance, paywall, discover, negotiate, session, escrow, delegate, identity, reputation, feedback, QR, off-ramp, BTC lend, and multi-agent coordination.

### Claude Code / Kiro CLI

```bash
# Install skill
cp SKILL.md ~/.kiro/skills/agent-payment/SKILL.md
```

### LangChain / CrewAI / AutoGen

```typescript
import { createPaymentClient } from 'n-payment';

// Use as a tool in any agent framework
const paymentTool = {
  name: 'pay_for_api',
  description: 'Pay for a paid API endpoint using USDC',
  execute: async (url: string) => {
    const client = createPaymentClient({ chains: ['base-mainnet'], ows: { wallet: 'agent' } });
    const res = await client.fetchWithPayment(url);
    return res.json();
  },
};
```

---

## How Payment Protocols Work

```
Agent                          Paid API                    Blockchain
  │                              │                            │
  │  1. GET /data ──────────────►│                            │
  │                              │                            │
  │  2. ◄──── 402 + challenge ──│                            │
  │     (x402: payment-required header)                       │
  │     (MPP: www-authenticate header)                        │
  │                              │                            │
  │  3. SDK auto-detects protocol                             │
  │  4. SDK signs payment ──────────────────────────────────►│
  │                              │                            │
  │  5. GET /data + proof ──────►│                            │
  │                              │  6. Verify payment         │
  │  7. ◄──── 200 + data ──────│                            │
```

---

## License

MIT
