# n-payment

Multi-protocol payment SDK for Web3 agents. Unifies [x402](https://x402.org), [MPP](https://mpp.dev), [GOAT x402](https://docs.goat.network/builders/x402), and [Stellar](https://stellar.org) behind a single `fetchWithPayment()` call — secured by the [Open Wallet Standard (OWS)](https://docs.openwallet.sh).

**Private keys never leave the OWS vault.** Every transaction is policy-gated.

[![npm](https://img.shields.io/npm/v/n-payment)](https://www.npmjs.com/package/n-payment)

## Install

```bash
npm install n-payment
```

## What's New in v0.7 — Stellar Agentic Economy

n-payment now supports **Stellar Network** with both **x402** and **MPP** protocols, plus **Trustless Work** escrow-based funding management for milestone-driven agent commerce.

```
┌─────────────────────────────────────────────────────────────────┐
│                    n-payment v0.7                                │
├─────────────────────────────────────────────────────────────────┤
│  Agent Consumer          │  Agent Provider                      │
│  createAgentClient()     │  createAgentProvider()               │
│  discover → negotiate    │  paidTool() → x402 gating           │
│  → pay → feedback        │  AgentCard → A2A discovery           │
├─────────────────────────────────────────────────────────────────┤
│  PricingEngine │ SessionManager │ EscrowManager │ Delegation    │
├─────────────────────────────────────────────────────────────────┤
│  Stellar (x402 + MPP)   │  Trustless Work (Escrow-as-a-Service)│
│  Base / Arbitrum (x402)  │  GOAT Network │ Tempo (MPP)          │
├─────────────────────────────────────────────────────────────────┤
│  PaymentClient (auto-detect) │ OWSWallet │ StellarWallet        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start — Stellar Payments

Pay for APIs on Stellar with automatic x402/MPP protocol detection:

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['stellar-testnet'],
  ows: { wallet: 'my-agent' },
  stellar: { secretKey: process.env.STELLAR_SECRET },
});

// SDK auto-detects x402 or MPP from the 402 response
const response = await client.fetchWithPayment('https://api.example.com/data');
```

## Quick Start — Trustless Work Escrow

Coordinate agent-to-agent payments with milestone-based escrow on Stellar:

```typescript
import { StellarWallet, TrustlessEscrowManager } from 'n-payment';

const wallet = new StellarWallet({ secretKey: process.env.STELLAR_SECRET });
const escrow = new TrustlessEscrowManager(wallet, { chain: 'stellar-testnet' });

// 1. Create escrow job with milestones
const job = await escrow.createJob({
  provider: 'GPROVIDER...', // Stellar address of service provider
  amount: '10000000',       // 10 USDC (7 decimals on Stellar)
  title: 'AI Research Task',
  milestones: [
    { description: 'Deliver initial analysis' },
    { description: 'Final report' },
  ],
  type: 'multi', // progressive milestone payouts
});

// 2. Fund the escrow
await escrow.fundJob(job.id);

// 3. Provider completes milestone
await escrow.submitMilestone(job.id, 0);

// 4. Approve and release funds for milestone
await escrow.approveAndRelease(job.id, 0);
```

---

## How Stellar Payment Works

```
Agent Client                 Facilitator/Soroban          Agent Provider
     │                              │                         │
     │  1. POST /api/data ──────────────────────────────────►│
     │                              │                         │ no payment
     │  2. ◄──────────────────────────────────────── 402 ────│
     │     payment-required: {stellar:testnet, amount, payTo} │
     │                              │                         │
     │  3. Sign Soroban auth entry  │                         │
     │                              │                         │
     │  4. verify + settle ────────►│ SAC transfer on-chain   │
     │                              │                         │
     │  5. POST /api/data + x-payment-signature ────────────►│
     │                              │                         │ returns data
     │  6. ◄──────────────────────────────────── 200 + data ─│
```

**Stellar Facilitators:**
- Testnet: `https://channels.openzeppelin.com/x402/testnet`
- Mainnet: `https://channels.openzeppelin.com/x402`

---

## Trustless Work — Escrow-as-a-Service

[Trustless Work](https://trustlesswork.com) provides non-custodial stablecoin escrows on Stellar (Soroban). n-payment integrates it for:

- **Agent-pays-for-service** — Fund escrow, provider delivers, approver releases
- **Platform escrow** — Marketplace with milestone-based payouts
- **Budget delegation** — Multi-release escrows for sub-agent coordination

### Escrow Lifecycle

```
Create → Fund → Submit Milestone → Approve → Release
                                 ↘ Dispute → Resolve
```

### Direct API Access

```typescript
import { TrustlessWorkClient, StellarWallet } from 'n-payment';

const tw = new TrustlessWorkClient({ apiUrl: 'https://dev.api.trustlesswork.com' });
const wallet = new StellarWallet({ secretKey: 'S...' });

// Deploy a single-release escrow
const { contractId, unsignedXdr } = await tw.deploySingleRelease({
  title: 'Logo Design',
  amount: '5000000',
  receiver: 'GDESIGNER...',
  serviceProvider: 'GDESIGNER...',
  approver: 'GCLIENT...',
  releaseSigner: 'GCLIENT...',
  milestones: [{ description: 'Deliver final logo files' }],
});

// Sign and submit
await tw.signAndSubmit(unsignedXdr, wallet, 'Test SDF Network ; September 2015');
```

---

## Quick Start — Agent Provider (Get Paid)

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
      price: 10000,
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

```typescript
import { createAgentClient } from 'n-payment';

const agent = createAgentClient({
  chain: 'base-sepolia',
  wallet: 'my-agent',
});

const result = await agent.discoverAndCall('weather', { city: 'Tokyo' });
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
| **Stellar Testnet** | `stellar-testnet` | **x402 + MPP** | Soroban |
| **Stellar Mainnet** | `stellar-mainnet` | **x402 + MPP** | Soroban |

---

## API Reference

### Stellar & Trustless Work

| Export | Purpose |
|--------|---------|
| `StellarWallet` | Stellar keypair wallet with Soroban auth signing |
| `StellarX402Adapter` | x402 payment adapter for Stellar |
| `StellarMppAdapter` | MPP payment adapter for Stellar |
| `TrustlessWorkClient` | REST client for Trustless Work escrow API |
| `TrustlessEscrowManager` | Agent-to-agent escrow lifecycle manager |

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
| `EscrowManager` | ERC-8183 programmable escrow (EVM) |
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

## License

MIT
