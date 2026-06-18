# n-payment

**The chain-agnostic SDK for agentic payments — one `fetchWithPayment(url)` call, any chain, any protocol, any stablecoin.**

```bash
npm install n-payment
```

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],                 // any of 27+ supported chains
  ows:    { wallet: 'my-agent' },
});

// That's the whole API. SDK auto-detects 402 → signs → retries.
const res  = await client.fetchWithPayment('https://api.example.com/data');
const data = await res.json();
```

n-payment is a TypeScript SDK that turns HTTP `402 Payment Required` into a one-line operation for AI agents. Your code calls a paywalled URL like any `fetch`. The SDK detects the payment protocol on the response, signs the right payment, and retries. It does not care whether the bill settles on an EVM chain, on XRPL, on Stellar, on a Cosmos chain, on Solana, or via a cross-chain bridge — the call site stays identical.

> **Why a chain-agnostic SDK matters for agents.** Agents pick endpoints based on capability and price, not chain. A research agent calling 30 paid APIs in a session should not care which chain each merchant settles on. n-payment moves that decision out of agent code and into config — the same `fetchWithPayment()` call works for every supported rail.

---

## What you get

- **One call, any rail.** `fetchWithPayment(url)` works across `x402`, MPP, GOAT x402, XRPL, Stellar (x402 + MPP + Sessions), Cosmos `MsgSend`, Soroban payment channels, on-chain `transferWithAuthorization`, NTT bridge-as-payment, and more.
- **Protocol auto-detection.** `detectProtocol(response)` reads the 402 headers and routes to the right adapter — no per-chain branching in your agent code.
- **Multichain wallet (OWS).** A single CAIP-2-keyed wallet that signs across **11 chain families** (EVM, Solana, XRPL, Cosmos, Bitcoin, Sui, Tron, TON, Spark, Filecoin, NEAR). One mnemonic, one config, every chain.
- **Policy & audit by default.** Per-tx, per-hour, per-day spending caps; rate limits; trusted-facilitator allowlist; queryable on-disk audit log keyed by `referenceKey`.
- **Sub-cent micropayments.** Off-chain vouchers (batch settlement) and Soroban payment channels for high-frequency / sub-cent flows.
- **Streaming + metered billing.** `StreamingPaymentManager` settles usage at intervals against a budget envelope.
- **Yield-bearing treasury.** Idle agent funds auto-supply to lending markets and auto-withdraw on demand. Your agent earns while it sleeps.
- **Sell APIs to other agents.** `createPaywall`, `paidTool`, and a spec-compliant **paid MCP server** turn any HTTP service into an agent-discoverable, agent-payable endpoint in <20 lines.
- **AP2 verifiable intent.** Cryptographic proof that a payment was authorized by a specific user mandate — survives audit and arbitration.
- **Cross-chain corridors.** When the agent's holdings and the merchant's chain don't match, `PayRouter` picks the cheapest available bridge / swap automatically.

Everything is opt-in. The minimal config above pulls in zero peer dependencies beyond `viem`.

---

## How `fetchWithPayment` works

```
Agent                                Paid API                          Adapter
  │                                    │                                  │
  │  1. GET /data ────────────────────▶│                                  │
  │                                    │                                  │
  │  2. ◀──── 402 + payment challenge ─│                                  │
  │     (header schema varies by protocol)                                │
  │                                                                       │
  │  3. detectProtocol(response)  ──▶  picks the right adapter            │
  │                                                                       │
  │  4. adapter.pay(challenge) ───────────────────────────────────────────▶
  │     (signs typed-data / tx / voucher / channel commitment)            │
  │                                                                       │
  │  5. GET /data + payment-proof header ▶ │                              │
  │                                       │  6. Verify (facilitator       │
  │                                       │     or on-chain)              │
  │  7. ◀──── 200 + body ────────────────│                                │
```

A few things worth calling out:

- **Step 3 is pure — the agent doesn't pick a chain.** The adapter falls out of the response. Your agent doesn't need to know whether a given URL is paywalled by an EVM facilitator or a Stellar anchor.
- **Step 4 is bounded by policy.** `SpendingGuard.check()` runs *before* signing. A blocked payment never touches a private key.
- **Step 5 retries on the same connection.** No second round trip to discover the protocol again.

The full flow is one method on `PaymentClient` — you don't compose it manually.

---

## Quickstarts

### Pay for any paid API (consumer)

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows:    { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY as `0x${string}` },
});

const res = await client.fetchWithPayment('https://api.example.com/data');
console.log(await res.json());
```

Want spending limits and an audit trail? Add `policy`:

```typescript
const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows:    { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY as `0x${string}` },
  policy: {
    maxPerTransaction:    100_000n,                // $0.10 per call (USDC, 6 decimals)
    maxPerHour:         1_000_000n,                // $1.00 / hour
    maxPerDay:         10_000_000n,                // $10.00 / day
    rateLimit:        { maxRequests: 100, windowMs: 60_000 },
    blocklist:        ['0xKnownScam...'],
    trustedFacilitators: ['https://api.cdp.coinbase.com/platform/v2/x402'],
  },
});

const res     = await client.fetchWithPayment('https://api.example.com/data');
const audit   = client.getGuard()?.getAudit();
const summary = audit?.getSpendingSummary(); // { total, count }
```

### Sell APIs to other agents (provider)

```typescript
import express from 'express';
import { createAgentProvider, paidTool, AgentCard } from 'n-payment';

const provider = createAgentProvider({
  name:        'WeatherBot',
  description: 'Weather data for AI agents',
  payTo:       '0xYourAddress',
  chain:       'base-mainnet',
  tools: [
    paidTool({
      name:        'forecast',
      description: 'Get weather forecast',
      price:        10_000n, // $0.01 USDC
      handler:      async ({ city }: { city: string }) => ({ city, temp: 22 }),
    }),
  ],
});

const app = express();
app.use(express.json());
app.use(provider.middleware());
app.get('/.well-known/agent.json', AgentCard.fromProvider(provider, 'https://your-api.com').handler());
app.listen(3000);
```

### Ship a paid MCP server

Make any tool a paid MCP endpoint that any MCP-spec client (Claude Desktop, Cursor, ChatGPT, AWS Bedrock AgentCore, etc.) can discover and pay over.

```typescript
import { createPaidMcpServer, paidTool } from 'n-payment/mcp';

const server = createPaidMcpServer({
  name:    'WeatherBot',
  payTo:   '0xYourAddress',
  chain:   'base-mainnet',
  tools: [
    paidTool({
      name:        'forecast',
      price:        10_000n,
      handler:      async ({ city }: { city: string }) => ({ city, temp: 22 }),
    }),
  ],
});

await server.listen(3000);
```

The host calls `tools/list` (sees price metadata), calls `tools/call` (gets MCP error `-32402` with the payment envelope), the host's wallet signs, the call retries with the proof header, and the response streams back. Spec-compliant. One file. No facilitator to self-host.

```bash
claude mcp add --transport http weather http://localhost:3000
```

`server.toExpressMiddleware()` and `server.handle(req: Request)` (Fetch-API) are also exposed for Cloudflare Workers / Bun / Deno.

---

## Agentic primitives

These are protocol-agnostic — they compose with any adapter the SDK ships.

### Multichain wallet — one mnemonic, eleven chain families

```typescript
import { OWSWallet, ows } from 'n-payment';

const w = new OWSWallet({ wallet: 'agent-treasury' });

// Same method, four chain families.
await w.getAddress('eip155:8453');         // 0x...
await w.getAddress('xrpl:mainnet');        // r...
await w.getAddress('solana:mainnet');      // 7xKX...
await w.getAddress('cosmos:interwoven-1'); // init1...

// Multi-agent isolation: scoped, revocable, policy-bound API keys.
const policy = await ows.createPolicy({ allowChains: ['eip155:8453'], maxValuePerTx: '5.00 USD' });
const key    = await ows.createApiKey({ name: 'sub-agent-A', wallets: ['agent-treasury'], policy });
// → hand `key.token` to a sub-agent. Revoke any time without touching the master mnemonic.
```

The wallet is CAIP-2-native: every method takes a chain ID as a string and dispatches to the right family — `eip155`, `solana`, `xrpl`, `cosmos`, `bip122`, `sui`, `tron`, `ton`, `spark`, `filecoin`, `near`. Chains with payrouter rails today get end-to-end `fetchWithPayment` support; other families ship wallet-bound (address derivation + signing) so your agent can already prove identity on every chain it touches.

### Policy engine + audit log

```typescript
import { PolicyEngine, AuditLog, SpendingGuard } from 'n-payment';

const engine = PolicyEngine.fromConfig({
  maxPerTransaction: 100_000n,
  maxPerDay:         10_000_000n,
  rateLimit:         { maxRequests: 100, windowMs: 60_000 },
});

const guard = new SpendingGuard(engine, new AuditLog());
const decision = guard.check({ amount: 50_000n, recipient: '0x...' });
// decision.allowed === true | false; decision.reason explains why.
```

Wired automatically inside `PaymentClient` when you pass `policy: {…}`. The audit log is queryable by `referenceKey` so you can reconcile agent spend against merchant orders.

### Batch settlement (sub-cent payments)

```typescript
import { BatchSettlementManager } from 'n-payment';

const batch = new BatchSettlementManager();

const session = batch.openSession({
  chain:         'base-mainnet',
  budget:         1_000_000n, // $1.00
  escrowContract: '0x...',
});

// Each API call: sign an off-chain voucher (zero gas).
const voucher = batch.signVoucher(session.id, 100n); // $0.0001

// Seller batch-settles many vouchers in one tx later.
```

### Streaming payments

```typescript
import { StreamingPaymentManager } from 'n-payment';

const streaming = new StreamingPaymentManager();

const stream = streaming.createStream({
  provider:        '0xProvider',
  chain:           'base-mainnet',
  budget:          5_000_000n,   // $5.00
  intervalMs:      60_000,        // settle every minute
  maxPerInterval:  100_000n,      // ≤ $0.10 / minute
});

streaming.recordUsage(stream.id, 1_000n); // $0.001
streaming.settleInterval(stream.id);
```

### Verifiable agent authorization (AP2)

```typescript
import { AP2Client } from 'n-payment';

const ap2 = new AP2Client({ agentId: 'my-agent-123' });

// User authorizes the agent with a budget and expiry.
const mandate = ap2.createCheckoutMandate({
  maxBudget: 5_000_000n,            // $5.00
  expiresAt: Date.now() + 3_600_000,
});

// Agent shops, then closes the mandate against a specific cart.
const closed = ap2.closeCheckoutMandate(mandate.id, {
  items:    [{ name: 'Weather API', price: 10_000n, quantity: 1 }],
  total:    10_000n,
  merchant: '0xProvider',
});

// Issue a payment mandate carrying cryptographic proof of authorization.
const payment = ap2.createPaymentMandate(closed.id, 10_000n, 'x402');
```

### Multi-agent delegation

```typescript
import { createAgentClient } from 'n-payment';

const leader      = createAgentClient({ chain: 'base-mainnet', wallet: 'leader-agent' });
const budget      = leader.createDelegation(5_000_000); // $5.00
const workerSlice = leader.delegate(budget, 1_000_000); // $1.00 to worker

const result = await leader.call('https://api.example.com/data', {
  delegationCtx: workerSlice,
});
```

### Yield-bearing treasury

Idle agent funds can auto-supply to a lending market (so they earn while sleeping) and auto-withdraw on demand:

```typescript
const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows:    { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY as `0x${string}` },
  aave: {
    autoYield:        true,            // supply idle USDC
    minIdleBalance:   10_000_000n,     // keep $10 liquid
    borrowEnabled:    true,            // borrow stablecoin against collateral instead of selling
    maxLTV:           70,
    preferGho:        true,            // pay with GHO when accepted (gasless via EIP-2612)
  },
});

await client.fetchWithPayment('https://paid-api.com/data');
const state = client.aave?.yield.getState();
// state.supplied, state.yieldEarned
```

Flash-mint batched payments and ERC-4626 vault management ship in the same module.

### Cross-chain corridor selection

When the agent holds funds on one chain and the merchant wants payment on another, the SDK can route automatically:

```typescript
import { selectRlusdCorridor } from 'n-payment';

const decision = selectRlusdCorridor({
  buyerHoldings: { 'optimism-mainnet': 5_000_000n },
  merchantWants: { chain: 'base-mainnet', amount: 1_500_000n },
});
// → { path: 'ntt-bridge', latencyMs: 75_000, ... }
```

Equivalent corridor selectors exist for Stellar multi-stable swaps (`selectAsset`), Cosmos USDC→iUSD bridging (`selectIusdCorridor`), and Mento corridors. PayRouter picks based on holdings, fees, and slippage caps you set in config.

---

## Selling: middleware for any HTTP framework

```typescript
import express from 'express';
import { createPaywall, createHealthEndpoint } from 'n-payment';

const config = {
  routes: {
    'GET /api/data': {
      price:       '10000', // $0.01 USDC, 6 decimals
      description: 'Premium data endpoint',
      x402:        { payTo: '0xYourAddress' },
    },
  },
};

const app = express();
app.use(express.json());
app.use(createPaywall(config));
app.get('/health',   createHealthEndpoint(config));
app.get('/api/data', (_req, res) => res.json({ result: 'paid content' }));
app.listen(3000);
```

Add an MPP block to the same route to accept both protocols at once:

```typescript
'GET /api/data': {
  price: '10000',
  x402:  { payTo: '0xYourAddress' },
  mpp:   { currency: '0x20c0...', recipient: '0xYourAddress' },
}
```

Need finer-grained access control? Compose the paywall with a KYA / KYC gate:

```typescript
import { StellarKyaGate } from 'n-payment';

const gate = new StellarKyaGate({ minKyaTier: 2 });
app.get('/skill', gate.middleware(), (_req, res) => res.json({ data: 'gated' }));
```

---

## Capability matrix

> Chains and protocols are config knobs. The agent code does not change.

| Family    | Chains                                                       | Protocols spoken                                                     | Notable capabilities                              |
| --------- | ------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------- |
| EVM       | Base, Arbitrum, BNB, Optimism, Ink, Unichain, Ethereum, GOAT, Morph, SpaceRouter chains, Flare, Songbird, Coston2, fee-abstracted L2s | `x402`, MPP, EIP-3009 sponsored, EIP-2612 permit, Permit2, fee-currency adapters | gas sponsoring, gasless payments, yield treasury  |
| Cosmos-SDK| Initia (and any `cosmos:*` namespace OWS supports)           | `cosmos-msgsend`                                                     | USDC→native-stable bridge corridor                |
| XRPL      | XRPL mainnet/testnet                                         | XRPL native, x402 (T54 / RLUSD-first), RLUSD payments, payment channels | invoice-bound presigned blobs settled via T54 facilitator; XRP↔RLUSD AMM auto-swap; vault treasury |
| Stellar   | Stellar mainnet/testnet                                      | x402, MPP, MPP Session (Soroban payment channels)                    | sub-cent off-chain commitments, multi-stable swap |
| Solana    | Solana mainnet/devnet                                        | x402                                                                 | SPL transfers                                     |
| Cross-chain | Any pair the corridor solver can connect                    | Wormhole NTT, LayerZero V2 OFT, Skip API, Mento                       | bridge-as-payment, atomic mint-and-pay            |

> A new chain or protocol is added by implementing one `PaymentAdapter` interface (`detect()` + `pay()`). Nothing in `PaymentClient` or in your agent code changes.

Concrete chain identifiers (full list in `CHAINS`):

```
base-mainnet, base-sepolia, arbitrum-sepolia, bnb-mainnet, bnb-testnet,
ethereum-mainnet, optimism-mainnet, ink-mainnet, unichain-mainnet,
goat-mainnet, goat-testnet, morph-mainnet, morph-hoodi-testnet,
creditcoin-mainnet, creditcoin-testnet,
flare-mainnet, flare-songbird-mainnet, flare-coston2-testnet,
xrpl-mainnet, xrpl-testnet,
stellar-mainnet, stellar-testnet,
solana-mainnet, solana-devnet,
tempo-mainnet, tempo-testnet,
initia-mainnet, initia-testnet,
celo-mainnet, celo-sepolia
```

Pick whichever subset your agent needs in the `chains:` field.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Your agent code                              │
│                fetchWithPayment(url)                                │
├─────────────────────────────────────────────────────────────────────┤
│  Policy Engine  →  Spending Guard  →  Audit Log                     │
├─────────────────────────────────────────────────────────────────────┤
│  Yield Treasury │ Batch Settlement │ Streaming │ AP2 Verifiable     │
├─────────────────────────────────────────────────────────────────────┤
│  detectProtocol(response)  →  PaymentAdapter dispatch               │
├─────────────────────────────────────────────────────────────────────┤
│  x402 │ MPP │ XRPL │ Stellar (x402+MPP+Sessions) │ EIP-3009 │ NTT  │
│  Solana x402 │ Cosmos MsgSend │ payment channels │ on-chain settle │
├─────────────────────────────────────────────────────────────────────┤
│  OWSWallet (CAIP-2 multichain)  │  Permit2 / EIP-3009 / EIP-712     │
└─────────────────────────────────────────────────────────────────────┘
```

All boxes are independently testable units. The agent only ever talks to the top one.

---

## Configuration reference

```typescript
createPaymentClient({
  // Required
  chains: ['base-mainnet'],
  ows:    { wallet: 'name', privateKey: '0x...' },

  // Optional
  protocol:        'auto',                                // 'x402' | 'mpp' | 'auto'
  policy:          { maxPerTransaction, maxPerDay, rateLimit, blocklist },
  ap2:             { agentId, signingKey },               // verifiable intent
  batchSettlement: { enabled: true },                     // sub-cent vouchers
  streaming:       { defaultInterval: 60_000 },           // metered billing
  x402:            { usePermit2: true },                  // Permit2 for any ERC-20

  // Treasury / corridors (all optional — opt in only what you need)
  aave:        { autoYield, minIdleBalance, borrowEnabled, preferGho, delegation },
  xrpl:        { seed, autoSwap, treasury, facilitatorUrl, sourceTag },
  stellar:     { secretKey, channelsApiKey },
  solana:      { keypair },
  morph:       { accessKey, secretKey, facilitatorUrl },
  goat:        { apiKey, apiSecret, merchantId, autoFund },
  flare:       { network, x402, gasless },
  initia:      { network, mnemonic },
  spacerouter: { region, ipType, autoEscrow },
  wormhole:    { signers, maxPerTransfer, maxPerDay },
  circle:      { apiKey, environment },
});
```

Each block is independent — leaving one out simply disables that adapter.

---

## API reference

### Core

| Export                    | Purpose                                       |
| ------------------------- | --------------------------------------------- |
| `createPaymentClient(c)`  | Make a payment client (auto-detects protocol) |
| `createPaywall(c)`        | Express paywall middleware                    |
| `createHealthEndpoint(c)` | Health / pricing endpoint                     |
| `detectProtocol(res)`     | Detect 402 protocol from a `Response`         |
| `CHAINS`, `getChain(k)`   | Chain registry + lookup                       |

### Wallet

| Export                                    | Purpose                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `OWSWallet({ wallet, privateKey? })`      | CAIP-2-keyed multichain wallet                    |
| `ows` (lifecycle namespace)               | Create / import / export / restore / rotate / lock / discover; policy & API-key CRUD |
| `parseCaip2`, `resolveFamily`             | CAIP-2 parsing helpers                            |

### Agent commerce

| Export                       | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| `createAgentProvider(c)`     | Sell services with paywall gating                |
| `createAgentClient(c)`       | Buy services with discovery                      |
| `paidTool(def)`              | Define a paid tool (MCP-compatible)              |
| `createPaidMcpServer(c)`     | Spec-compliant paid MCP server                   |
| `AgentCard.fromProvider()`   | Generate A2A Agent Card                          |
| `PricingEngine`              | Dynamic pricing (demand / reputation / outcome)  |
| `SessionManager`             | Micropayment sessions                            |
| `EscrowManager`              | ERC-8183 programmable escrow                     |
| `PaymentNegotiator`          | Auto-select direct / escrow / credit             |
| `ReputationRouter`           | Trust-weighted provider selection                |
| `DelegationManager`          | Multi-agent budget chains                        |

### Settlement & policy

| Export                     | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `BatchSettlementManager`   | Off-chain vouchers + cumulative settlement           |
| `StreamingPaymentManager`  | Interval-based streaming payments                    |
| `Permit2Signer`            | EIP-712 Permit2 for any ERC-20                       |
| `PolicyEngine`             | Spending limits, rate limits, blocklist              |
| `AuditLog`                 | Queryable payment history (by `referenceKey`)        |
| `SpendingGuard`            | Wraps payments with policy enforcement               |

### AP2 protocol

| Export                     | Purpose                                              |
| -------------------------- | ---------------------------------------------------- |
| `AP2Client`                | Agent Payments Protocol (Google / FIDO)              |
| `VerifiableIntentSigner`   | Tamper-proof agent action authorization              |

### Adapters (auto-loaded by `PaymentClient`)

`X402Adapter`, `MppAdapter`, `GoatAdapter`, `XrplAdapter`, `StellarX402Adapter`, `StellarMppAdapter`, `MorphX402Adapter`, `SpaceRouterAdapter`, `FlareX402Adapter`, `WormholeNttAdapter`, `RlusdExactAdapter`, `InitiaIusdAdapter`, `CeloFeeAbstractedAdapter`, `CircleGatewayAdapter`, `SolanaX402Adapter`, `AaveGhoAdapter`.

You almost never reference these directly — `PaymentClient` picks the right one based on the chains you configure and the 402 challenge it sees.

---

## Error handling

```typescript
import {
  NPaymentError,
  InsufficientBalanceError,
  AdapterNotFoundError,
  ChallengeParseError,
} from 'n-payment';

try {
  await client.fetchWithPayment(url);
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    console.log('Fund wallet:', err.hint);
  } else if (err instanceof AdapterNotFoundError) {
    console.log('Wrong chain config:', err.hint);
  } else if (err instanceof ChallengeParseError) {
    console.log('Malformed 402 from server:', err.hint);
  } else if (err instanceof NPaymentError) {
    console.log(`${err.code}: ${err.message}`);
  } else {
    throw err;
  }
}
```

Every error carries a `code` and an actionable `hint`. The audit log records the failure reason regardless of whether the payment was attempted.

---

## Agent decision guide

| You want to…                                | Use this                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| Pay for any paid API automatically          | `createPaymentClient()` → `fetchWithPayment(url)`                         |
| Sell your API for crypto                    | `createAgentProvider()` + `paidTool()`                                    |
| Ship a paid MCP server                      | `createPaidMcpServer()` from `n-payment/mcp`                              |
| Find services to buy                        | `createAgentClient()` → `discover(query)`                                 |
| Limit spending                              | `policy: { maxPerDay, rateLimit, blocklist }`                             |
| Sub-cent micropayments                      | `BatchSettlementManager`                                                  |
| Streaming / metered billing                 | `StreamingPaymentManager`                                                 |
| Multi-agent budget sharing                  | `DelegationManager` or `ows.createApiKey({ policy })`                     |
| Escrow for high-value tasks                 | `EscrowManager` or `TrustlessEscrowManager`                               |
| Prove user authorization (AP2)              | `AP2Client` + `VerifiableIntentSigner`                                    |
| Earn yield on idle funds                    | `aave: { autoYield: true }`                                               |
| Pay across chains automatically             | `PayRouter` corridor selectors + adapter-specific bridge config           |

---

## For agent frameworks

n-payment ships as a single `import`, which makes it trivial to wrap as a tool in any framework.

### LangChain / CrewAI / AutoGen

```typescript
import { createPaymentClient } from 'n-payment';
import { Tool } from 'langchain/tools';

class PaidApiTool extends Tool {
  name        = 'pay_for_api';
  description = 'Call any paid API; SDK auto-handles HTTP 402 across any supported chain.';
  private client = createPaymentClient({ chains: ['base-mainnet'], ows: { wallet: 'agent' } });

  async _call(url: string) {
    const res = await this.client.fetchWithPayment(url);
    return JSON.stringify(await res.json());
  }
}
```

### Model Context Protocol

`createPaidMcpServer()` (above) is what you ship to MCP-aware hosts. Any tool defined with `paidTool()` becomes spec-compliant `tools/list` + `tools/call` with x402 monetization.

### Kiro CLI / Claude Code

```bash
cp SKILL.md ~/.kiro/skills/agent-payment/SKILL.md
```

The skill exposes 19 payment tools (pay, balance, paywall, discover, negotiate, session, escrow, delegate, identity, reputation, feedback, off-ramp, multi-agent coordination, …).

---

## Why agents need a chain-agnostic SDK

1. **Chain selection happens at config, not at call time.** Agents that hard-code chains break the moment a service prices a call differently on another rail.
2. **A single audit trail across rails.** Reconcile spend by `referenceKey` regardless of which chain the proof landed on.
3. **One wallet, many identities.** OWS-bound CAIP-2 addresses on 11 chain families let an agent prove identity wherever it needs to without juggling key material.
4. **Policy is the same everywhere.** `maxPerDay` enforced on EVM is the same `maxPerDay` enforced on XRPL — the guard runs above the adapter.
5. **Cross-chain corridors are an SDK concern, not an agent concern.** When the agent's wallet and the merchant's chain disagree, a corridor selector picks a bridge / swap behind the scenes.

If your agent is going to call dozens of paid APIs across a session, you do not want chain logic in your prompt context. You want a function that takes a URL and returns a body.

That is `fetchWithPayment(url)`.

---

## License

MIT
