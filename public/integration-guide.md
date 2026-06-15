# n-payment Integration Guide

A chain-agnostic guide for wiring n-payment into your agent. Every flow shown here works the same way regardless of which chain or protocol the merchant is using — the SDK detects the right rail off the 402 response.

---

## Installation

```bash
npm install n-payment
```

The only required runtime dependency is `viem`. Adapter-specific peers (xrpl, @stellar/stellar-sdk, @solana/web3.js, @cosmjs/stargate, ethers, mppx, @x402/*, @wormhole-foundation/sdk, @skip-go/client, @open-wallet-standard/core) are listed as **optional** peer dependencies — install only the ones you actually use.

### Wallet bootstrap (OWS)

```bash
# Install OWS (Open Wallet Standard) CLI — optional but recommended
curl -fsSL https://docs.openwallet.sh/install.sh | bash

ows wallet create --name my-agent
ows wallet derive --wallet my-agent --chain eip155:8453   # EVM
ows wallet derive --wallet my-agent --chain xrpl:mainnet  # XRPL
ows wallet derive --wallet my-agent --chain solana:mainnet
```

Or skip OWS entirely and pass a private key:

```typescript
ows: { wallet: 'my-agent', privateKey: process.env.PRIVATE_KEY as `0x${string}` }
```

### Environment variables (only what each adapter needs)

| Variable                | Used by                                         |
| ----------------------- | ----------------------------------------------- |
| `OWS_WALLET`            | Default OWS wallet name                         |
| `CDP_API_KEY`           | CDP-hosted x402 facilitator (mainnet)           |
| `GOAT_API_KEY` / etc.   | GOAT Network x402 / BTC lending                 |
| `STELLAR_SECRET_KEY`    | Stellar adapters                                |
| `MORPH_ACCESS_KEY`      | Morph x402 (HMAC facilitator)                   |
| `XRPL_SEED`             | XRPL adapter                                    |
| `INITIA_MNEMONIC`       | Initia / Cosmos `MsgSend`                       |
| `WORMHOLE_*`            | Wormhole NTT cross-chain corridor               |

Most agents only need `OWS_WALLET` (or `PRIVATE_KEY`) plus the env block for whichever chains they target.

---

## 1. Buyer integration — call any paid API automatically

### Minimal example

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows:    { wallet: 'my-agent' },
});

const res  = await client.fetchWithPayment('https://api.example.com/data');
const data = await res.json();
```

`fetchWithPayment()` handles the full 402 cycle: request → detect protocol → run policy guard → sign payment → retry with proof header → return body. The chain it settles on is whatever the server's challenge specifies — the agent never picks.

### Multi-chain configuration

Configure every chain your agent might encounter; the SDK picks based on the 402 challenge:

```typescript
const client = createPaymentClient({
  chains: [
    'base-mainnet',
    'arbitrum-sepolia',
    'xrpl-mainnet',
    'stellar-mainnet',
    'solana-mainnet',
    'initia-mainnet',
  ],
  ows: { wallet: 'my-agent' },
});

// Agent code never branches on chain — same call regardless of which rail the merchant uses.
const res = await client.fetchWithPayment(serviceUrl);
```

### With spending policy + audit log

```typescript
const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows:    { wallet: 'my-agent' },
  policy: {
    maxPerTransaction:    100_000n,                // $0.10
    maxPerHour:         1_000_000n,                // $1.00
    maxPerDay:         10_000_000n,                // $10.00
    rateLimit:        { maxRequests: 100, windowMs: 60_000 },
    blocklist:        ['0xKnownScam...'],
    trustedFacilitators: ['https://api.cdp.coinbase.com/platform/v2/x402'],
  },
});

await client.fetchWithPayment(url);

const audit = client.getGuard()?.getAudit();
const summary = audit?.getSpendingSummary();      // { total, count }
const entry   = audit?.queryByReferenceKey('...'); // reconcile against merchant order
```

### With service discovery

```typescript
import { createPaymentClient, createBazaarClient } from 'n-payment';

const bazaar = createBazaarClient({
  facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
});

const { resources } = await bazaar.search('weather');
const service       = resources[0];

const client = createPaymentClient({ chains: ['base-mainnet'], ows: { wallet: 'my-agent' } });
const res    = await client.fetchWithPayment(service.resource);
```

---

## 2. Seller integration — accept agent payments on your API

```typescript
import express from 'express';
import { createPaywall, createHealthEndpoint } from 'n-payment';

const config = {
  routes: {
    'GET /api/data': {
      price:       '10000',  // $0.01 USDC, 6 decimals
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

### Multi-protocol on the same route

```typescript
'GET /api/data': {
  price: '10000',
  x402:  { payTo: '0xYourAddress' },
  mpp:   { currency: '0x20c0...', recipient: '0xYourAddress' },
}
```

`createPaywall` will accept either an `x402` payment header or an MPP credential. The agent client picks whichever matches its configured chain — without your server caring which one arrives.

---

## 3. Agent-commerce integration — sell tools, not endpoints

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
      price:        10_000n,
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

### As a paid MCP server

```typescript
import { createPaidMcpServer, paidTool } from 'n-payment/mcp';

const server = createPaidMcpServer({
  name:    'WeatherBot',
  payTo:   '0xYourAddress',
  chain:   'base-mainnet',
  tools: [paidTool({ name: 'forecast', price: 10_000n, handler: async () => ({ temp: 22 }) })],
});

await server.listen(3000);
```

Any MCP-spec host (Claude Desktop, Cursor, ChatGPT, AWS Bedrock AgentCore, etc.) can register, discover, pay, and call.

---

## 4. Agent-framework wrappers

### Generic payment tool

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({ chains: ['base-mainnet'], ows: { wallet: 'my-agent' } });

export async function callPaidApi(url: string) {
  const res = await client.fetchWithPayment(url);
  return res.json();
}
```

### LangChain

```typescript
import { Tool } from 'langchain/tools';
import { createPaymentClient } from 'n-payment';

class PaidApiTool extends Tool {
  name        = 'paid_api';
  description = 'Call any paid API; SDK auto-handles 402 across any supported chain.';
  private client = createPaymentClient({ chains: ['base-mainnet'], ows: { wallet: 'agent' } });
  async _call(url: string) { return JSON.stringify(await (await this.client.fetchWithPayment(url)).json()); }
}
```

### Discovery + pay (any framework)

```typescript
import { createBazaarClient, createPaymentClient } from 'n-payment';

const bazaar = createBazaarClient({ mockCatalog: true });
const client = createPaymentClient({ chains: ['base-mainnet'], ows: { wallet: 'my-agent' } });

async function callPaidService(query: string) {
  const { resources } = await bazaar.search(query);
  if (!resources.length) throw new Error(`No service for: ${query}`);
  return client.fetchWithPayment(resources[0].resource);
}
```

---

## 5. Streaming / batch / sub-cent flows

For high-frequency calls or sub-cent prices, swap the on-chain settle for an off-chain primitive.

```typescript
import { BatchSettlementManager, StreamingPaymentManager } from 'n-payment';

// Off-chain vouchers, batched onchain later (good for hundreds of micro-calls)
const batch   = new BatchSettlementManager();
const session = batch.openSession({ chain: 'base-mainnet', budget: 1_000_000n, escrowContract: '0x...' });
const voucher = batch.signVoucher(session.id, 100n);

// Interval-based streaming (good for metered LLM / API consumption)
const streaming = new StreamingPaymentManager();
const stream    = streaming.createStream({
  provider: '0xProvider', chain: 'base-mainnet',
  budget: 5_000_000n, intervalMs: 60_000, maxPerInterval: 100_000n,
});
streaming.recordUsage(stream.id, 1_000n);
streaming.settleInterval(stream.id);
```

---

## 6. Off-ramp integration

```typescript
import { OffRampClient, MockMoonPayAdapter } from 'n-payment';

const offramp = new OffRampClient(new MockMoonPayAdapter());

const quote = await offramp.getQuote({
  amount: '100.00', token: 'USDC', chain: 'base-mainnet', fiatCurrency: 'USD',
});

const receipt = await offramp.withdraw({
  amount: '100.00', token: 'USDC', chain: 'base-mainnet',
  destination: { type: 'bank_account', id: 'bank-123' },
});
```

A real-world Stellar SEP-24 anchor adapter (`StellarAnchorClient`) is also exported — it handles SEP-10 auth + SEP-24 cash-out polling end to end.

---

## 7. Configuration reference

```typescript
interface NPaymentConfig {
  chains: ChainKey[];           // any subset of CHAINS — 27+ supported
  ows:    { wallet: string; privateKey?: `0x${string}` };
  protocol?: 'x402' | 'mpp' | 'auto';

  policy?: {
    maxPerTransaction?: bigint;
    maxPerHour?:        bigint;
    maxPerDay?:         bigint;
    rateLimit?:         { maxRequests: number; windowMs: number };
    blocklist?:         string[];
    trustedFacilitators?: string[];
  };

  ap2?:             AP2Config;
  batchSettlement?: { enabled: true };
  streaming?:       { defaultInterval: number };
  x402?:            { usePermit2: boolean };

  // Adapter-specific blocks (all optional — only used when a chain in `chains` needs it)
  aave?:        AaveConfig;
  xrpl?:        XrplConfig;
  stellar?:     StellarConfig;
  solana?:      { keypair };
  morph?:       MorphConfig;
  goat?:        GoatCredentials;
  flare?:       FlareConfig;
  initia?:      InitiaConfig;
  spacerouter?: SpaceRouterConfig;
  wormhole?:    WormholeConfig;
  circle?:      CircleConfig;

  analytics?: { plugins: AnalyticsPlugin[] };
}
```

A new chain or protocol is added by implementing the `PaymentAdapter` interface (`detect()` + `pay()`); nothing in `PaymentClient` or in your agent code changes.

---

## 8. Testnet → mainnet migration

```diff
  const client = createPaymentClient({
-   chains: ['base-sepolia'],
+   chains: ['base-mainnet'],
    ows:    { wallet: 'my-agent' },
  });
```

Mainnet checklist:

- [ ] Fund the OWS wallet on every chain you configured
- [ ] Set adapter env vars (e.g. `CDP_API_KEY` for the CDP facilitator)
- [ ] Tighten `policy.maxPerTransaction` / `maxPerDay` to fiat caps
- [ ] Pre-load `aave.minIdleBalance` if you enabled `autoYield`
- [ ] Run a small-amount end-to-end before scaling up

---

## 9. Error handling

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
  if (err instanceof InsufficientBalanceError) console.log('Fund wallet:', err.hint);
  else if (err instanceof AdapterNotFoundError)  console.log('Wrong chain config:', err.hint);
  else if (err instanceof ChallengeParseError)   console.log('Malformed 402:', err.hint);
  else if (err instanceof NPaymentError)         console.log(`${err.code}: ${err.message}`);
  else throw err;
}
```

| Error                          | Code                   | When                                              |
| ------------------------------ | ---------------------- | ------------------------------------------------- |
| `NPaymentError`                | various                | Base class                                        |
| `InsufficientBalanceError`     | `INSUFFICIENT_BALANCE` | Wallet can't cover the required amount            |
| `AdapterNotFoundError`         | `NO_ADAPTER`           | Detected protocol has no adapter for your chains  |
| `ChallengeParseError`          | `CHALLENGE_PARSE`      | The 402 response can't be parsed                  |

Every error carries a `code` and an actionable `hint`. The audit log records the failure regardless of whether a payment was attempted — useful for post-hoc reconciliation.

---

## See also

- `README.md` — full SDK overview, capability matrix, agentic primitives.
- `CHANGELOG.md` — release-by-release feature additions.
- `docs/` — protocol-specific PRDs and architecture notes for each rail (EVM x402, MPP, XRPL, Stellar, Solana, Cosmos / Initia, Wormhole NTT, Aave treasury, etc.).
