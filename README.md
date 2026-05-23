# n-payment

The payment layer for AI agents. One SDK, every protocol.

Unifies [x402](https://x402.org), [MPP](https://mpp.dev), [GOAT x402](https://docs.goat.network), [Stellar](https://stellar.org), [XRPL](https://xrpl.org), [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments), [AP2](https://ap2-protocol.org), and [Aave](https://aave.com) behind a single `fetchWithPayment()` call — with policy-gated spending, batch settlement, yield-bearing treasury, and full audit trail.

**v0.15 highlights:** Flare FXRP direct-minting bridge on Coston2 testnet — one XRPL `Payment` to the FAssets Core Vault with a 32-byte memo and the caller's auto-resolved Flare PersonalAccount receives FXRP. Fire-and-forget, viem-based, no operator self-host required.

**v0.14 highlights:** XRPL XRP→RLUSD auto-swap via native AMM (atomic cross-currency Payment, slippage-bounded), XLS-65 vault treasury yield-parity, per-wallet concurrency mutex, `XrplClient.health()` preflight, testnet RLUSD issuer fix.

**v0.13 highlights:** Aave yield-bearing treasury (earn 2-6.5% APY on idle funds), GHO stablecoin payments with EIP-2612 gasless permits, Flash Mint batch settlement, credit delegation for multi-agent teams, ERC-4626 vault management.

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
│                         n-payment v0.13                              │
├─────────────────────────────────────────────────────────────────────┤
│  YOUR CODE: fetchWithPayment(url)                                   │
├─────────────────────────────────────────────────────────────────────┤
│  Policy Engine → Spending Guard → Audit Log → trustedFacilitators   │
├─────────────────────────────────────────────────────────────────────┤
│  Aave Treasury: Auto-Yield │ GHO Payments │ Flash Mint │ Vaults    │
├─────────────────────────────────────────────────────────────────────┤
│  Batch Settlement │ Streaming Payments │ Circle Nanopayments        │
├─────────────────────────────────────────────────────────────────────┤
│  x402 │ MPP │ GOAT │ Stellar │ XRPL │ Solana │ BNB │ Morph │ SR   │
├─────────────────────────────────────────────────────────────────────┤
│  OWS Wallet │ Viem │ Stellar Wallet │ XRPL Wallet │ Solana Keypair │
├─────────────────────────────────────────────────────────────────────┤
│  Agent Commerce: Discovery → Negotiate → Pay → Feedback             │
│  AP2 Protocol: Verifiable Intent → Checkout Mandate → Payment       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Supported Chains (19)

| Chain | Key | Protocol | Use Case |
|-------|-----|----------|----------|
| Base | `base-mainnet` | x402 | Production payments |
| Base Sepolia | `base-sepolia` | x402 | Testing |
| Arbitrum Sepolia | `arbitrum-sepolia` | x402 | Testing |
| **BNB Chain** | `bnb-mainnet` | x402 | **High-volume payments** |
| **BNB Testnet** | `bnb-testnet` | x402 | **Testing** |
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
| **Morph** | `morph-mainnet` | Morph x402 | **Agentic payments, Reference Key** |
| **Morph Hoodi Testnet** | `morph-hoodi-testnet` | Morph x402 | **Testing** |
| **Creditcoin** | `creditcoin-mainnet` | SpaceRouter | **Agentic bandwidth, residential proxy ($SPACE)** |
| **Creditcoin CC3 Testnet** | `creditcoin-testnet` | SpaceRouter | **Testing** |
| **Flare Coston2 Testnet** | `flare-coston2-testnet` | Flare FXRP | **XRP→FXRP direct-minting bridge (v0.15)** |

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
    trustedFacilitators: ['https://api.cdp.coinbase.com/platform/v2/x402'],
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

## Quick Start — Stellar Agentic Payments (v0.10)

n-payment v0.10 ships first-class support for Stellar's full agentic payment stack: x402, MPP Charge (one-time), and **MPP Session** (off-chain payment channels via the `one-way-channel` Soroban contract — true sub-cent micropayments without per-call gas).

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['stellar-testnet'],
  ows: { wallet: 'my-agent' },
  stellar: {
    secretKey: process.env.STELLAR_SECRET,        // S...
    channelsApiKey: process.env.OZ_API_KEY,       // optional — only for OZ Channels mainnet
  },
});

// Pay any Stellar-protected API (x402 or MPP Charge auto-detected)
const res = await client.fetchWithPayment('https://api.example.com/data', undefined, {
  referenceKey: 'ORD-2026-001',
});
```

**Credential-less testnet:** Omit `secretKey` and the SDK warns and disables the Stellar adapters (other chains still work). Default facilitator is Coinbase free testnet (sponsored fees).

**MPP Session — high-frequency micropayments:**

```typescript
const session = client.createStellarSession({
  channel: 'C...',                              // pre-deployed one-way-channel contract
  commitmentSecretHex: process.env.COMMITMENT_SECRET, // 64-char hex ed25519 seed
  chainKey: 'stellar-testnet',
});

// Sign 100 off-chain commitments — zero on-chain tx, zero fees
for (let i = 0; i < 100; i++) {
  const { credential } = await session.signCommitment(10_000n); // 0.001 USDC each
  await fetch(url, { headers: { Authorization: `Payment ${credential}` } });
}
// Server settles all 100 with one close() transaction when convenient
```

**Browser wallet (Freighter):**

```typescript
import { FreighterStellarSigner, StellarX402Adapter } from 'n-payment';

const signer = await FreighterStellarSigner.connect(); // prompts user for wallet access
const adapter = new StellarX402Adapter(signer, 'stellar-testnet');
```

**Try it locally:**
```bash
pnpm tsx examples/stellar-demo.ts charge-server   # paywall on :3001
pnpm tsx examples/stellar-demo.ts charge-client   # buyer agent
pnpm tsx examples/stellar-demo.ts session         # 100 off-chain commitments
```

## Quick Start — Morph Network (v0.9)

Pay APIs on Morph with HMAC-signed x402 facilitator + per-order Reference Key tracking:

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['morph-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
  morph: {
    accessKey: process.env.MORPH_ACCESS_KEY,    // morph_ak_...
    secretKey: process.env.MORPH_SECRET_KEY,    // morph_sk_...
  },
});

// Pay with a merchant order ID — flows through to retry header + audit log
const res = await client.fetchWithPayment('https://api.example.com/data', undefined, {
  referenceKey: 'ORD-2026-001',
  metadata: { customer: 'alice' },
});

// Reconcile — query audit by reference key
const entries = client.getGuard()?.getAudit().queryByReferenceKey('ORD-2026-001');
```

**Credential-less dev mode:** Configure Morph chain without `accessKey`/`secretKey` for development; the SDK warns and disables the Morph adapter without throwing. Get keys at [Morph x402 Console](https://morph-rails.morph.network/x402).

**AltFee (gas-in-stablecoin):** Type-0x7F transaction support is **scaffolded for v0.10** — setting `morph.altFee.enabled` throws `NOT_IMPLEMENTED` with a roadmap link.

**Try it locally:**
```bash
pnpm tsx examples/morph-demo.ts server   # merchant paywall on :3030
pnpm tsx examples/morph-demo.ts client   # buyer agent with referenceKey
pnpm tsx examples/morph-demo.ts bridge   # same code, Morph + Base
```

## Quick Start — SpaceRouter / SpaceCoin (v0.11)

Buy **residential bandwidth** for your agent on Creditcoin. Pay $SPACE on-chain, route HTTP/SOCKS5 through real residential IPs, and combine with any 402 paywall in a single call.

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['creditcoin-mainnet', 'morph-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.SR_PRIVATE_KEY },
  spacerouter: {
    region: 'KR',
    ipType: 'residential',
    autoEscrow: { minBalance: 1n * 10n ** 18n, topUpAmount: 5n * 10n ** 18n, claimThreshold: 10 },
  },
  morph: { accessKey: process.env.MORPH_ACCESS_KEY, secretKey: process.env.MORPH_SECRET_KEY },
});

// Force the residential proxy:
const r = await client.fetchWithPayment('https://httpbin.org/ip', undefined, { proxy: 'spacerouter' });

// Or smart fallback — try direct, route via SpaceRouter only if blocked, then settle 402 if encountered:
const r2 = await client.fetchWithPayment('https://paywalled-api.example.com/data', undefined, {
  proxy: 'auto', region: 'US',
  referenceKey: 'ORD-2026-001',
});

await client.close(); // flushes buffered receipts
```

**What you get:** unified bandwidth + payment audit trail (`bandwidth` and `payment` audit entry kinds), policy controls (`bandwidthMaxPerHour`, `allowedRegions`, `allowedIpTypes`), 5-day-timelock-aware withdrawals, and the same `OWSWallet` identity reused across Morph, Stellar, x402, and SpaceRouter.

**Tree-shakable subpath:**
```typescript
import { SpaceRouterClient } from 'n-payment/spacerouter';
```

**Peer dep (optional):** install `@spacenetwork/spacerouter` only if you actually use the proxy.

**Try it locally:**
```bash
pnpm add @spacenetwork/spacerouter
pnpm tsx examples/spacerouter-demo.ts proxy           # residential IP via region: KR
pnpm tsx examples/spacerouter-demo.ts smart-fallback  # auto-route on CF block
pnpm tsx examples/spacerouter-demo.ts combined        # SpaceRouter + Morph 402 in one call
```

## Quick Start — Aave Yield-Bearing Treasury (v0.13)

The only payment SDK that **pays you back**. Idle agent funds auto-supply to Aave (2-6.5% APY). When you need to pay, the SDK auto-withdraws. Your agent earns yield while sleeping.

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
  aave: {
    autoYield: true,              // Auto-supply idle USDC to Aave
    minIdleBalance: 10_000000n,   // Keep $10 liquid, rest earns yield
    borrowEnabled: true,          // Borrow GHO against collateral instead of selling
    maxLTV: 70,                   // Max 70% loan-to-value
    preferGho: true,              // Pay with GHO when accepted (gasless via EIP-2612)
  },
});

// Agent pays for API — SDK auto-withdraws from Aave if needed
const res = await client.fetchWithPayment('https://paid-api.com/data');

// Check treasury state
const state = client.aave?.yield.getState();
console.log('Supplied to Aave:', state?.supplied);  // earning yield
console.log('Yield earned:', state?.yieldEarned);
```

**What happens under the hood:**
1. Agent deposits 100 USDC → SDK keeps $10 liquid, supplies $90 to Aave
2. Agent calls `fetchWithPayment($5)` → SDK checks liquid balance ($10 ≥ $5) → pays directly
3. Agent calls `fetchWithPayment($15)` → liquid ($5) < needed ($15) → SDK auto-withdraws $10 from Aave → pays
4. After payment → SDK sweeps excess back to Aave → continues earning

**GHO Stablecoin Payments (gasless):**

```typescript
// When a server accepts GHO, the SDK mints GHO from your collateral
// and pays with EIP-2612 permit (zero gas for the approval)
const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
  aave: { autoYield: true, borrowEnabled: true, preferGho: true },
});

// If server accepts GHO (0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee on Base):
// SDK mints GHO against your ETH/USDC collateral, signs gasless permit, pays
const res = await client.fetchWithPayment('https://gho-accepting-api.com/data');
```

**Flash Mint Batch Settlement (zero capital):**

```typescript
import { FlashMintBatcher, GhoManager } from 'n-payment';

const gho = new GhoManager({ preferGho: true }, 'ethereum');
const batcher = new FlashMintBatcher(gho);

// Accumulate many small payments
batcher.addPayment('0xSeller1', 10000n);  // $0.01
batcher.addPayment('0xSeller2', 50000n);  // $0.05
batcher.addPayment('0xSeller3', 5000n);   // $0.005

// Settle ALL in one atomic tx via GHO Flash Mint (zero capital needed)
const batch = batcher.buildBatchTx('0xYourBatchReceiver');
console.log(`Settling ${batch.paymentCount} payments, total: ${batch.totalAmount}`);
// One on-chain tx instead of 100 → 100x gas savings
```

**Credit Delegation (multi-agent teams):**

```typescript
import { createPaymentClient } from 'n-payment';

// Parent agent: supplies collateral, delegates borrowing power to sub-agents
const parent = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'parent-agent', privateKey: process.env.PARENT_KEY },
  aave: {
    autoYield: true,
    borrowEnabled: true,
    delegation: {
      enabled: true,
      delegates: ['0xSubAgent1', '0xSubAgent2'],
      maxPerDelegate: 100_000000n,  // Each sub-agent can borrow up to $100
    },
  },
});
// Sub-agents borrow against parent's collateral — no fund transfers needed
```

**GHO Token Addresses:**

| Chain | GHO Address |
|-------|-------------|
| Ethereum | `0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f` |
| Base | `0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee` |
| Arbitrum | `0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33` |
| Avalanche | `0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73` |

## Quick Start — Flare FXRP Bridge (v0.15)

Bridge XRP into FXRP on Flare's Coston2 testnet with a single XRPL `Payment`. The SDK auto-resolves the caller's Flare `PersonalAccount`, encodes the 32-byte direct-minting memo, computes the protocol fees on-chain, and returns the validated XRPL tx hash. No operator/executor self-host required.

```typescript
import {
  createFlareClient,
  FlareBridgeClient,
  XrplConnection,
  XrplWallet,
  getFxrpBalance,
} from 'n-payment';

const flare = createFlareClient(); // defaults to Coston2 testnet
const xrplWallet = new XrplWallet({ seed: process.env.XRPL_SEED! });
const xrplConnection = new XrplConnection('xrpl-testnet');

const bridge = new FlareBridgeClient({ flare, xrplConnection, xrplWallet });
const receipt = await bridge.mintFXRP({ amountXrp: '10' });

console.log('XRPL tx:', receipt.xrplTxHash);
console.log('PersonalAccount:', receipt.recipientPersonalAccount);
console.log('Net FXRP credited:', receipt.netFxrp); // after fees

// Poll for the executor-driven mint to land (~30–90s):
const balance = await getFxrpBalance(flare, receipt.recipientPersonalAccount);
```

**Try it locally:**
```bash
export XRPL_SEED=sEd...   # https://xrpl.org/resources/dev-tools/xrp-faucets
pnpm tsx examples/flare-bridge-demo.ts registry       # verify on-chain registry
pnpm tsx examples/flare-bridge-demo.ts state-lookup   # PersonalAccount + balances
pnpm tsx examples/flare-bridge-demo.ts quote 10       # fees + gross XRP
pnpm tsx examples/flare-bridge-demo.ts mint 5         # send the XRPL Payment
```

See [`docs/guide-flare-fxrp-bridge.md`](./docs/guide-flare-fxrp-bridge.md) for the full architecture, fee maths, error codes, and what's deferred to v0.16.

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
| Residential-IP bandwidth ($SPACE) | `proxy: 'spacerouter'` or `'auto'` in `fetchWithPayment` |
| **Earn yield on idle funds** | **`aave: { autoYield: true }`** |
| **Pay XRPL paywalls with only XRP** | **`xrpl: { autoSwap: true, treasury: { autoYield: true, autoCreate: true } }`** |
| **Pay with GHO (gasless)** | **`aave: { preferGho: true, borrowEnabled: true }`** |
| **Batch 100+ payments in 1 tx** | **`FlashMintBatcher` → `buildBatchTx()`** |
| **Multi-agent shared treasury** | **`aave: { delegation: { delegates: [...] } }`** |
| **Manage yield vault (earn fees)** | **`VaultManager` → `buildDepositTx()`** |

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
