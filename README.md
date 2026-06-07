# n-payment

**The SDK that lets your AI agent pay for residential proxy in $SPACE on Creditcoin — two prompts, zero crypto setup.**

One npm install, one wallet, two prompts. Your agent gets unblocked from datacenter-IP-hostile sites (Cloudflare 1010/1020), pays per-byte in $SPACE on Creditcoin (chainId `102030`), and ships an on-chain audit trail with a 5-day-timelock-protected escrow. Nothing to deploy.

> **v0.22 highlights** — RLUSD on 6 chains in one `fetchWithPayment` call: XRPL native + Ethereum + Base + Optimism + Ink + Unichain via Wormhole NTT 1.1.0. Facilitator-independent on-chain settlement (no Coinbase CDP dependency for any RLUSD chain). New `selectRlusdCorridor` pure-fn cross-chain router; `WormholeNttClient` + `WormholeNttAdapter` with per-tx + per-day caps; `RlusdExactAdapter` + on-chain `verifyExactRlusdPayment` / `verifyWormholeNttPayment` middleware helpers. **Backward compatible** — strict superset of v0.21.

## RLUSD on six chains, one `fetchWithPayment` (v0.22)

n-payment is the only agentic-payment SDK that natively speaks **Ripple USD (RLUSD)** on every chain where it's been issued. NYDFS-regulated, $1.72B market cap (8th-largest stable globally).

| Chain | RLUSD address | Rail |
|---|---|---|
| XRPL Mainnet | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` (issuer) | XRPL native — `XrplAdapter` |
| Ethereum | `0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD` | x402 + Wormhole NTT |
| Base | `0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258` | x402 + Wormhole NTT |
| Optimism | `0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258` | x402 + Wormhole NTT |
| Ink | `0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258` | x402 + Wormhole NTT |
| Unichain | `0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258` | x402 + Wormhole NTT |

```typescript
import { createPaymentClient } from 'n-payment';
import { ethers } from 'ethers'; // optional peer dep — only if you bridge

const client = createPaymentClient({
  chains: ['xrpl-mainnet', 'base-mainnet', 'optimism-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.OWS_KEY as `0x${string}` },
  wormhole: {
    signers: {
      Optimism: new ethers.Wallet(process.env.OPTIMISM_KEY!,
        new ethers.JsonRpcProvider(process.env.OPTIMISM_RPC)),
      Base: new ethers.Wallet(process.env.BASE_KEY!,
        new ethers.JsonRpcProvider(process.env.BASE_RPC)),
    },
    maxPerTransfer: 100n  * 10n ** 18n,
    maxPerDay:      1000n * 10n ** 18n,
  },
});

// Pay 1.5 RLUSD to a paid-MCP on Base — even if you only hold RLUSD on Optimism.
// PayRouter v3 corridor auto-bridges via Wormhole NTT (~30s VAA + 5s redeem + 5s settle).
await client.fetchWithPayment('https://api.example.com/llm');
```

**Three primitives ship together:**

```bash
# Full corridor demo (XRPL + 5 EVM chains)
pnpm tsx examples/rlusd-multichain-demo.ts

# Bridge-only smoke (used as $0.10 mainnet pre-publish gate)
pnpm tsx examples/rlusd-ntt-bridge-only.ts --from optimism --to base --amount 0.10

# Agent skill matching the existing pay-*.sh JSON contract
bash skills/pay-rlusd-multichain.sh https://api.example.com/llm
```

**Facilitator-independent settlement** — `RlusdExactAdapter` broadcasts a real on-chain `RLUSD.transfer()`; the merchant verifies via on-chain Transfer log with no facilitator dependency. Coinbase CDP doesn't cover Ethereum/Optimism/Ink/Unichain (and never RLUSD); we sidestep that entirely. See `docs/PRD-rlusd-x402-facilitator-adapter.md` for the two settlement primitives (Primitive A — `exact`; Primitive B — `wormhole-ntt-transfer` bridge-as-payment).

See [`docs/PRD-v022-master-rlusd-wormhole-ntt.md`](./docs/PRD-v022-master-rlusd-wormhole-ntt.md) for the full architecture, all 6 sub-PRDs, and the GTM plan.

## Unified XRPFi corridor — XRP ↔ FXRP ↔ RLUSD round-trip (v0.22.1)

Closes the loop back to XRPL through Flare's FAssets. With v0.22.1 the SDK rounds-trips XRP across **3 ecosystems** (XRPL native, Flare FAssets, EVM RLUSD via Wormhole NTT) in one `fetchWithPayment(url)` call.

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['xrpl-mainnet', 'flare-mainnet', 'base-mainnet', 'optimism-mainnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.OWS_KEY as `0x${string}` },
  xrpl: { seed: process.env.XRPL_SEED, autoSwap: true },
  flare: { network: 'flare-mainnet' },
  xrpfi: { enabled: true, redemptionTimeoutMs: 600_000, swapMaxSlippageBps: 100 },
});

// Reverse leg: agent holds FXRP on Flare; merchant wants RLUSD on XRPL.
// SDK redeems FXRP → XRP → swaps to RLUSD-XRPL automatically. Total ~3-8 min.
await client.fetchWithPayment('https://api.example.com/xrpl-paid-mcp');
```

**Decision tree** the corridor walks under the hood:

| Holdings | Merchant wants | Path | Latency |
|---|---|---|---|
| RLUSD on Base | RLUSD on Base | `direct` | 5–15s |
| RLUSD on Optimism | RLUSD on Base | `ntt-bridge` (PRD-B) | 75–90s |
| **FXRP on Flare** | **RLUSD on XRPL** | **`xrpfi-redeem-then-swap`** | **3–8 min** |
| **FXRP on Flare** | **RLUSD on Base/Op/Ink/Uni** | **`xrpfi-redeem-swap-then-bridge`** (pre-wired, activates when Wormhole adds XRPL) | future |
| **XRP on XRPL only** | **RLUSD on EVM** | **`xrpfi-mint-fxrp`** (forward partial — stops at FXRP) | 30–90s |

**Try it:**

```bash
# Forward — XRP → FXRP (stops at Flare; v0.23 closes the loop)
pnpm tsx examples/xrpfi-roundtrip-demo.ts --mode=forward

# Reverse — FXRP → XRP → RLUSD on XRPL (full closure today)
pnpm tsx examples/xrpfi-roundtrip-demo.ts --mode=reverse

# Auto — corridor decides based on holdings
pnpm tsx examples/xrpfi-roundtrip-demo.ts --mode=auto
```

Backward compatible — `xrpfi.enabled` defaults to false; v0.22.0 callers see identical behavior.

---

> **v0.20 highlights** — `parseSpace`/`formatSpace` 18-decimal helpers, zero-balance preflight, sharper gateway error hints (`SR_RATE_LIMITED` / `SR_NO_PROVIDERS` / `SR_PROVIDER_UNREACHABLE` all carry actionable hints), runnable `examples/spacerouter-quickstart.ts`, agent-skill `skills/pay-spacerouter.sh`, env-gated cc3-testnet integration suite. **Backward compatible** — non-SpaceRouter chains (Flare, Morph, GOAT, XRPL, Stellar, Aave, Solana, Base/x402) untouched.

```bash
npm install n-payment
# Optional peer-dep, only needed for `pay`:
npm install @spacenetwork/spacerouter
```

## Two prompts, zero crypto setup (Creditcoin × SpaceRouter)

**Prompt 1 — "check my balance on creditcoin-testnet"**

```bash
export CREDITCOIN_PRIVATE_KEY=0x...
bash skills/pay-spacerouter.sh check-balance --chain creditcoin-testnet
# → {"ok":true,"data":{"chain":"creditcoin-testnet","consumer":"0x...","balanceSpace":"0",...}}
```

**Prompt 2 — "pay for httpbin.org/ip via SpaceRouter, region KR, residential"**

```bash
bash skills/pay-spacerouter.sh pay \
  --url https://httpbin.org/ip \
  --region KR --ip-type residential \
  --chain creditcoin-testnet
# → {"ok":true,"data":{"status":200,"nodeId":"...","requestId":"...","bodyPreview":"{...}"}}
```

Same flow from TypeScript:

```typescript
import { CHAINS, SpaceRouterClient, KeypairSpaceRouterSigner, parseSpace, formatSpace } from 'n-payment';

const chain  = CHAINS['creditcoin-mainnet'];
const signer = new KeypairSpaceRouterSigner(process.env.CREDITCOIN_PRIVATE_KEY as `0x${string}`);
const client = new SpaceRouterClient({
  chain, signer,
  escrowAddress: '0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0', // mainnet TokenPaymentEscrow
  tokenAddress:  '0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9', // $SPACE (18 decimals)
  privateKey:    process.env.CREDITCOIN_PRIVATE_KEY as `0x${string}`,
  region: 'KR', ipType: 'residential',
});

// (one-time, only if balance is 0): await client.deposit(parseSpace('1'));
const r = await client.fetch('https://httpbin.org/ip');
console.log(r.status, await r.text());
await client.close();
```

If escrow is empty, the SDK fails fast with `SR_ESCROW_EMPTY` and a concrete hint (`Run client.deposit(parseSpace('1')) ...`) before any network call. Every gateway failure (`SR_AUTH_FAILED` · `SR_RATE_LIMITED` · `SR_NO_PROVIDERS` · `SR_PROVIDER_UNREACHABLE`) carries an actionable hint, so your agent never sees a raw stack trace.

**Why Creditcoin** — `creditcoin-mainnet` (chainId `102030`) and `creditcoin-testnet` (`102031`) are first-class entries in `chains.ts`. The SDK already knows the RPC, the $SPACE token (18 decimals — handled by `parseSpace`/`formatSpace`), and the `gateway.spacerouter.org` facilitator. EVM-compatible — same viem/ethers/hardhat your agent already uses. See [`docs/PRD-creditcoin-spacerouter-wedge.md`](docs/PRD-creditcoin-spacerouter-wedge.md) for the full architecture and the [Substack outline](docs/SUBSTACK-OUTLINE-why-creditcoin.md) for the BD case.

**Try it locally:**

```bash
# Read-only — no $SPACE required:
npx tsx examples/spacerouter-quickstart.ts check

# Send a request through SpaceRouter (peer-dep + funded escrow required):
pnpm add @spacenetwork/spacerouter
npx tsx examples/spacerouter-quickstart.ts pay --url https://httpbin.org/ip --region KR --ip-type residential

# Run the env-gated integration test against cc3-testnet (read-only RPC):
SR_INTEGRATION=1 CREDITCOIN_PRIVATE_KEY=0x... pnpm test tests/spacerouter.test.ts
```

---

## Other protocols

### Stellar (v0.21) — multi-stable: MGUSD + USDC + EURC

n-payment v0.21 ships first-class support for the Stellar brand stablecoin set — including **MoneyGram MGUSD**, the first global retail-cash payment company's native stablecoin (launched 2026-06-02). Sub-cent micropayments via Soroban one-way payment channels with asset-aware preimages; multi-stable corridor routing; SEP-10/24 anchor off-ramp.

```typescript
import {
  StellarSessionClient,
  parseStellarAsset,
  StellarAnchorClient,
  selectAsset,
} from 'n-payment';

// 1. Pay sub-cent in MGUSD via Stellar Session
const client = new StellarSessionClient({
  channel: process.env.STELLAR_MGUSD_CHANNEL!,
  asset: 'MGUSD',                                       // v0.21 — asset-aware preimage
  commitmentSecretHex: process.env.STELLAR_COMMITMENT_SECRET!,
  chainKey: 'stellar-testnet',
});
const voucher = await client.signCommitment(parseStellarAsset('0.001', 'MGUSD'));
// Attach as Authorization: Payment <voucher.credential>

// 2. Multi-stable router — pick the optimal asset for the corridor
const decision = selectAsset({
  requested: 'MGUSD',
  buyerHoldings: ['USDC'],
  corridor: 'us-mx',
  allowAutoConvert: true,
});
// → { kind: 'auto-convert', from: 'USDC', to: 'MGUSD', via: 'stellar-amm', estimatedSlippageBps: 30 }

// 3. Off-ramp at any of MoneyGram's 500K retail locations
const offramp = new StellarAnchorClient();
const handle = await offramp.cashOut('10.00', 'MGUSD', 'USD', signer, 'US');
console.log(`Open ${handle.moreInfoUrl} to complete cash-out at MoneyGram retail.`);
```

**Three artifacts that close the loop:**

```bash
# Run the SCF #44 hero benchmark — 1000 MGUSD micropayments, single Stellar tx.
pnpm tsx examples/stellar-mgusd-1000-calls.ts

# Run the agent-earns-MGUSD → MoneyGram-retail-cash off-ramp demo.
pnpm tsx examples/stellar-mgusd-offramp-demo.ts

# Agent skill (matches sibling pay-*.sh JSON contract).
bash skills/pay-stellar-mgusd.sh --help
```

**KYA-gated paid endpoints** — require a verified Know-Your-Agent tier before serving paid responses. Compose with M0's compliance hooks:

```typescript
import express from 'express';
import { StellarKyaGate } from 'n-payment';

const gate = new StellarKyaGate({ minKyaTier: 2 });
const app = express();
app.get('/skill', gate.middleware(), (req, res) => {
  res.json({ data: 'gated by KYA tier 2' });
});
```

See [`docs/PRD-v021-master-stellar-mgusd.md`](./docs/PRD-v021-master-stellar-mgusd.md) for the full v0.21 architecture, the 7-gap research substrate, and the SCF #44 narrative.

---

n-payment v0.19 unifies [x402](https://x402.org), [MPP](https://mpp.dev), [GOAT x402](https://docs.goat.network), [Stellar](https://stellar.org), [XRPL](https://xrpl.org), [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments), [AP2](https://ap2-protocol.org), [Aave](https://aave.com), [Flare FXRP + x402 + Gasless](https://flare.network), and [Morph](https://morphl2.io) behind a single `fetchWithPayment()` call — with policy-gated spending, batch settlement, yield-bearing treasury, and full audit trail.

Unifies [x402](https://x402.org), [MPP](https://mpp.dev), [GOAT x402](https://docs.goat.network), [Stellar](https://stellar.org), [XRPL](https://xrpl.org), [Circle Nanopayments](https://developers.circle.com/gateway/nanopayments), [AP2](https://ap2-protocol.org), and [Aave](https://aave.com) behind a single `fetchWithPayment()` call — with policy-gated spending, batch settlement, yield-bearing treasury, and full audit trail.

**v0.19 highlights:** Flare agentic payments — `FlareX402Adapter` (buyer EIP-3009 against MockUSDT0 + on-chain `X402Facilitator`), thin `createPaywall` extension for selling APIs on Flare, `FlareGaslessForwarderClient` (sends FXRP gaslessly via custom EIP-712 forwarder + relayer), `FlareBridgeClient.executeGaslessFxrpPayment(...)` facade, three Flare networks (Coston2 + Songbird + Flare mainnet), one-shot viem deploy helpers for MockUSDT0 + X402Facilitator + GaslessPaymentForwarder, standalone Express relayer (`examples/flare-gasless-relayer.ts`), and `pay-flare-x402.sh` skill.

**v0.17 highlights:** GOAT USDC Acquisition Router — agents on GOAT Network self-fund USDC on a 402 challenge by picking the cheapest available rail: in-GOAT `PegBTC→USDC` swap (OKU/Uniswap V3), cross-chain `LayerZero V2 OFT` from Base/Polygon/Arbitrum/Optimism/BSC/Metis, or `BTC L1 → BitVM peg-in → PegBTC`. One-line presets (`safeDefaults`, `swapOnly`, `aggressive`, `testnet`), per-wallet mutex, idempotency cache, dry-run mode, partial-fill, PSBT-tampering guard, separate spending caps via `SpendingGuard.checkAcquisition()`, and Mock adapters that ship deterministic receipts for testnet/CI without external endpoints.

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
| **Flare Coston2 Testnet** | `flare-coston2-testnet` | Flare FXRP + x402 | **XRP→FXRP bridge + MockUSDT0 x402 + gasless FXRP (v0.19)** |
| **Flare Songbird Mainnet** | `flare-songbird-mainnet` | Flare FXRP + x402 | **Canary network (v0.19)** |
| **Flare Mainnet** | `flare-mainnet` | Flare FXRP + x402 | **Production agentic-payment network (v0.19)** |

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

## Quick Start — Ship a Paid MCP Server (v0.16)

Make any tool a paid MCP endpoint that **Base MCP**, **AWS Bedrock AgentCore**, **Claude Desktop**, **ChatGPT**, **Cursor**, **Codex**, and any MCP-spec client can discover and pay over x402-on-Base.

```typescript
import { createPaidMcpServer, paidTool } from 'n-payment/mcp';

const server = createPaidMcpServer({
  name: 'WeatherBot',
  description: 'Weather data for AI agents',
  payTo: '0xYourAddress',
  chain: 'base-mainnet',
  tools: [
    paidTool({
      name: 'forecast',
      description: 'Get weather forecast',
      price: 10000n, // $0.01 USDC
      handler: async ({ city }: { city: string }) => ({ city, temp: 22 }),
    }),
  ],
});

await server.listen(3000);
```

Now wire it to any host:

```bash
claude mcp add --transport http weather http://localhost:3000
```

The agent calls `tools/list` (sees price metadata), calls `tools/call` (gets MCP error `-32402` with the x402 envelope), the host's wallet (Base Account, Coinbase Agentic Wallet, OWS, etc.) signs an EIP-3009 `transferWithAuthorization`, the call retries with the `x-payment` header, and the response streams back. **Spec-compliant. One file. No facilitator to self-host.**

Also exposes `server.toExpressMiddleware()` and `server.handle(req: Request)` (Fetch-API) for Cloudflare Workers / Bun / Deno deployment.

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

## Quick Start — Morph Hoodi Testnet (v0.18)

Pay on **Morph Hoodi Testnet** (chainId 2910) using EIP-3009 sponsored payments — buyer agents transact with **zero ETH** for gas. The SDK ships a self-hostable custom facilitator (`createMorphHoodiFacilitator`) so no Morph-Rails Hoodi service is required. USDC is the operator-supplied test deploy at `0x7433b41C6c5e1d58D4Da99483609520255ab661B`.

**1. Run the facilitator** (one terminal — sponsor pays gas):

```bash
export MORPH_HOODI_SPONSOR_KEY=0x...   # Hoodi-funded account
pnpm tsx examples/morph-hoodi-facilitator.ts
# → http://localhost:4040/x402/v2/{supported,verify,settle}
```

Or embed it in your own Express app:

```typescript
import express from 'express';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, createMorphHoodiFacilitator } from 'n-payment';

const chain = CHAINS['morph-hoodi-testnet'];
const viemChain = defineChain({ id: chain.chainId, name: chain.name,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } } });
const sponsor = privateKeyToAccount(process.env.MORPH_HOODI_SPONSOR_KEY as `0x${string}`);
const handler = createMorphHoodiFacilitator({
  usdcAddress: chain.tokens.USDC as `0x${string}`,
  publicClient: createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) }) as never,
  sponsorClient: createWalletClient({ account: sponsor, chain: viemChain, transport: http(chain.rpcUrl) }) as never,
  sponsorAddress: sponsor.address,
});

const app = express();
app.use(express.json());
app.use((req, res, next) => Promise.resolve(handler(req as never, res as never)).catch(next));
app.listen(4040);
```

**2. Run a Hoodi-paywalled merchant** (paywall middleware emits `scheme: 'eip3009'`):

```typescript
import { createPaywall } from 'n-payment';

app.use(createPaywall({
  routes: {
    'GET /api/data': {
      price: '10000', // 0.01 USDC (6 decimals)
      morph: {
        payTo: '0xYourMerchantAddress',
        network: 'eip155:2910',
        asset: '0x7433b41C6c5e1d58D4Da99483609520255ab661B',
        scheme: 'eip3009',
      },
    },
  },
}));
```

**3. Pay from a buyer agent** (point `morph.facilitatorUrl` at your facilitator):

```typescript
import { createPaymentClient } from 'n-payment';

const buyer = createPaymentClient({
  chains: ['morph-hoodi-testnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY }, // buyer with Hoodi USDC
  morph: { facilitatorUrl: 'http://localhost:4040/x402' },
});

await buyer.fetchWithPayment('https://api.example.com/data', undefined, {
  referenceKey: 'ORD-2026-001',
});
```

**All-in-one local e2e** (merchant + facilitator + buyer in one process):

```bash
export MORPH_HOODI_SPONSOR_KEY=0x...
export OWS_PRIVATE_KEY=0x...
pnpm tsx examples/morph-demo.ts hoodi
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

## Quick Start — Acquire USDC on GOAT (v0.17)

GOAT Network has no native USDC issuer — the asset arrives via cross-chain bridges or DEX swaps. The **USDC Acquisition Router** lets your agent self-fund USDC on a 402 challenge by picking the cheapest available rail: PegBTC→USDC swap (OKU/Uniswap V3), cross-chain LayerZero V2 OFT, or BTC L1 BitVM peg-in.

```typescript
import { createPaymentClient, GoatAcquisitionPresets } from 'n-payment';

const client = createPaymentClient({
  chains: ['goat-testnet'],
  ows: { wallet: 'goat-agent', privateKey: process.env.PRIVATE_KEY },
  goat: {
    apiKey: process.env.GOAT_API_KEY!,
    apiSecret: process.env.GOAT_API_SECRET!,
    merchantId: process.env.GOAT_MERCHANT_ID!,
    autoFund: GoatAcquisitionPresets.safeDefaults(), // swap+oft, $1/hr cap, 1% fee, 0.5% slippage
  },
});

// Agent calls a GOAT x402-gated API — SDK auto-acquires USDC if short.
const res = await client.fetchWithPayment('https://api.x402.goat.network/data');
```

**What happens under the hood when USDC is short:**
1. Adapter detects insufficient USDC on the GOAT 402 challenge
2. Router reads the agent's balance sheet via Multicall3 (1 RPC call, lazy)
3. `BalanceSheetStrategy` picks the cheapest viable path:
   - has PegBTC → **swap** on OKU
   - has USDC on Base/Polygon/etc. → **oft** via LayerZero V2
   - has BTC L1 → **pegin** via hosted BitVM bridge (PSBT validated before signing)
4. `SpendingGuard.checkAcquisition()` enforces hourly/daily caps
5. Acquisition emits an `audit.type='acquisition'` entry with path, fee, txhash
6. GOAT order lifecycle continues — USDC transferred, proof retrieved, request retried

**One-line presets:**

| Preset | Paths | Caps | Use case |
|---|---|---|---|
| `safeDefaults()` | `swap`, `oft` | $1/hr, $10/day, 1% fee, 0.5% slip | Recommended default |
| `swapOnly()` | `swap` | $5/hr, $50/day | BTC-treasury agents, no cross-chain risk |
| `oftOnly()` | `oft` | $5/hr, $50/day | Multi-chain treasuries on Base/Polygon |
| `peginOnly()` | `pegin` | $50/hr, $500/day | Cold-storage BTC top-ups |
| `aggressive()` | all 3 | $100/hr, $1k/day, 3% fee | High-volume agents |
| `testnet()` | all 3 (mock) | $1k/hr | Local dev / CI |

**Custom config** (override any preset field):
```typescript
goat: {
  // ...
  autoFund: { ...GoatAcquisitionPresets.safeDefaults(), maxPerHour: 5_000_000n },
  bridgeUrl: 'https://bridge.goat.network',         // hosted BitVM endpoint
  btcSigner: myBtcSigner,                            // your PSBT-signing wallet (Sparrow/Xverse/HW)
  usdcOverride: '0xYourCustomUsdcOnGoat',           // escape hatch — emits warning
  dexOverride: { router: '0x...', quoter: '0x...' }, // OKU pool overrides
},
```

**BtcSigner contract (you supply, SDK never holds BTC keys):**
```typescript
import type { BtcSigner } from 'n-payment';
const myBtcSigner: BtcSigner = {
  async signPsbt(psbtBase64) { /* sign with Sparrow / hw wallet / PSBT lib */ return signedHex; },
  async getAddress() { return 'bc1q...'; },
};
```

**Try it locally (testnet, no external endpoints needed):**
```bash
pnpm tsx examples/goat-testnet-quickstart.ts            # all scenarios
pnpm tsx examples/goat-testnet-quickstart.ts --scenario swap
pnpm tsx examples/goat-testnet-quickstart.ts --scenario oft
pnpm tsx examples/goat-testnet-quickstart.ts --scenario pegin
```

**Manual acquire (without 402 trigger):**
```typescript
import { UsdcAcquisitionRouter, GoatAcquisitionPresets, SpendingGuard, PolicyEngine, AuditLog } from 'n-payment';

const router = new UsdcAcquisitionRouter({
  goatChain: 'goat-mainnet',
  wallet: client.wallet,
  config: GoatAcquisitionPresets.safeDefaults(),
  guard: new SpendingGuard(new PolicyEngine([]), new AuditLog()),
});

// Probe without executing
const decision = await router.estimate({ targetUsdcWei: 5_000_000n });
console.log('Cheapest path:', decision?.path, 'fee:', decision?.quote.feeBps, 'bps');

// Execute (idempotency-keyed; mutex-serialised)
const result = await router.acquire({ targetUsdcWei: 5_000_000n, idempotencyKey: 'order-123' });
```

**Error codes** (every code carries an actionable `hint`):

| Code | Meaning |
|---|---|
| `GOAT_NO_VIABLE_PATH` | No allowed path covers the target — fund the wallet or extend `allowedPaths` |
| `GOAT_BTC_SIGNER_MISSING` | `pegin` allowed but no `btcSigner` configured |
| `GOAT_OFT_PEER_DEP_MISSING` | `oft` allowed but `@layerzerolabs/oft-evm` not installed |
| `GOAT_BRIDGE_PSBT_TAMPERED` | Bridge response did not match intent — aborted before signing |
| `GOAT_AUTOFUND_LIMIT_EXCEEDED` | Hourly/daily acquisition cap hit |
| `GOAT_SWAP_SLIPPAGE_EXCEEDED` | OKU quote breached `maxSlippageBps` |
| `GOAT_OFT_FEE_TOO_HIGH` | LZ V2 quote breached `maxFeeBps` |

## Quick Start — Flare Agentic Payments (v0.19)

Two complementary flows on Flare's three networks (Coston2 testnet, Songbird, Flare mainnet):

**1. x402 with MockUSDT0** — pay APIs on Flare via EIP-3009 + on-chain `X402Facilitator` contract. Standard x402 flow; merchant calls the facilitator to verify+settle.

```typescript
import { createPaymentClient } from 'n-payment';

const buyer = createPaymentClient({
  chains: ['flare-coston2-testnet'],
  ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY },
  flare: {
    network: 'coston2-testnet',
    x402: {
      tokenAddress: process.env.FLARE_X402_TOKEN_ADDRESS as `0x${string}`,
      facilitatorAddress: process.env.FLARE_X402_FACILITATOR_ADDRESS as `0x${string}`,
    },
  },
});

await buyer.fetchWithPayment('https://api.example.com/data');
```

**Sell APIs on Flare** — extend `createPaywall` with a `flare` route + viem clients; the merchant settles on-chain inside the middleware.

```typescript
import express from 'express';
import { createPaywall } from 'n-payment';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const merchant = privateKeyToAccount(process.env.MERCHANT_KEY as `0x${string}`);
const chain = { /* ...flare-coston2 viem chain def... */ } as never;
const publicClient = createPublicClient({ chain, transport: http() });
const walletClient = createWalletClient({ account: merchant, chain, transport: http() });

const app = express();
app.use(express.json());
app.use(
  createPaywall(
    {
      routes: {
        'GET /api/data': {
          price: '100000', // 0.1 USDT0 (6 decimals)
          flare: {
            payTo: merchant.address,
            asset: process.env.FLARE_X402_TOKEN_ADDRESS as `0x${string}`,
            facilitatorAddress: process.env.FLARE_X402_FACILITATOR_ADDRESS as `0x${string}`,
            chainId: 114, network: 'flare-coston2',
          },
        },
      },
    },
    { publicClient, walletClient },
  ),
);
```

**2. Gasless FXRP transfers** — send FXRP without holding FLR for gas. One-time `approve(MaxUint256)` to the forwarder; subsequent payments are sponsored by your relayer.

```typescript
import {
  createFlareClient,
  FlareGaslessForwarderClient,
  FlareBridgeClient,
} from 'n-payment';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const flare = createFlareClient({ network: 'coston2-testnet' });
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: flare.publicClient.chain!, transport: http() });
const walletClient = createWalletClient({ account, chain: flare.publicClient.chain!, transport: http() });

const gasless = new FlareGaslessForwarderClient({
  publicClient: publicClient as never,
  walletClient: walletClient as never,
  forwarderAddress: process.env.FLARE_FORWARDER_ADDRESS as `0x${string}`,
  relayerUrl: 'http://localhost:3000',
});

// One-time setup: approve the forwarder.
const status = await gasless.getStatus(account.address);
if (status.needsApproval) await gasless.approve();

// Send 0.1 FXRP gaslessly. Sponsor (your relayer) pays FLR.
await gasless.pay({ to: '0xRecipient' as `0x${string}`, amount: 100_000n });
```

**Run your own relayer** — `pnpm tsx examples/flare-gasless-relayer.ts` boots an Express service on `:3000` with `POST /execute`, `GET /nonce/:addr`, `GET /healthz`. The sponsor account pays FLR for gas.

**Try it locally:**
```bash
# Compile contracts via Flare's Hardhat starter, then:
export FLARE_PRIVATE_KEY=0x... X402_ARTIFACT_DIR=...
pnpm tsx examples/flare-payments-demo.ts deploy-x402     # one-shot deploy MockUSDT0 + X402Facilitator
pnpm tsx examples/flare-payments-demo.ts x402            # buyer + merchant in one process
pnpm tsx examples/flare-payments-demo.ts deploy-gasless  # GaslessPaymentForwarder
pnpm tsx examples/flare-payments-demo.ts gasless         # buyer flow against running relayer
```

See [`docs/PRD-flare-agentic-payments.md`](./docs/PRD-flare-agentic-payments.md) for full architecture, decisions, and operational notes.

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
