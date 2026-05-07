# n-payment

Multi-protocol payment SDK for Web3 agents. Unifies [x402](https://x402.org), [MPP](https://mpp.dev), and [GOAT x402](https://docs.goat.network/builders/x402) behind a single `fetchWithPayment()` call — secured by the [Open Wallet Standard (OWS)](https://docs.openwallet.sh).

**Private keys never leave the OWS vault.** Every transaction is policy-gated.

[![npm](https://img.shields.io/npm/v/n-payment)](https://www.npmjs.com/package/n-payment)

## Install

```bash
npm install n-payment
```

> **npm:** https://www.npmjs.com/package/n-payment

## Step-by-Step Guide

### Step 1: Set Up OWS Wallet

The SDK uses [Open Wallet Standard](https://docs.openwallet.sh) for secure key management. No private keys in your code.

```bash
# Install OWS CLI
curl -fsSL https://docs.openwallet.sh/install.sh | bash

# Create a wallet for your agent
ows wallet create --name my-agent

# Fund wallet on testnet
ows fund deposit --wallet my-agent
```

**Alternative (development only):** Pass a `privateKey` directly for quick testing:

```typescript
ows: { wallet: 'dev-agent', privateKey: process.env.PRIVATE_KEY }
```

### Step 2: Create a Payment Client (Buyer)

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-sepolia'],          // Which chains to support
  ows: { wallet: 'my-agent' },       // OWS wallet name
});
```

### Step 3: Make Paid API Requests

The client auto-detects the payment protocol (x402 or MPP) from the server's 402 response:

```typescript
// Automatically handles 402 → detect protocol → pay → retry
const response = await client.fetchWithPayment('https://api.example.com/premium-data');
const data = await response.json();
console.log(data);
```

That's it for the buyer side. The SDK handles:
1. Initial request → receives 402
2. Parses payment challenge from headers
3. Detects protocol (x402 vs MPP)
4. Signs and sends payment via OWS wallet
5. Retries request with payment proof

### Step 4: Create a Paywall (Seller)

Protect your API endpoints with a payment wall that supports both x402 and MPP:

```typescript
import express from 'express';
import { createPaywall, createHealthEndpoint } from 'n-payment';

const app = express();

const paywallConfig = {
  routes: {
    'GET /api/weather': {
      price: '10000',                              // in smallest unit (e.g. 0.01 USDC)
      description: 'Weather data',
      x402: { payTo: '0xYourWalletAddress' },      // x402 payment recipient
      mpp: { currency: '0x20c0...', recipient: '0xYourWalletAddress' },  // MPP config
    },
    'POST /api/translate': {
      price: '50000',
      x402: { payTo: '0xYourWalletAddress' },
    },
  },
};

// Add paywall middleware — returns 402 with payment challenges
app.use(createPaywall(paywallConfig));

// Health endpoint shows pricing for all routes
app.get('/health', createHealthEndpoint(paywallConfig));

// Your actual route handlers (only reached after payment)
app.get('/api/weather', (req, res) => {
  res.json({ city: 'Tokyo', temp: 22 });
});

app.listen(3000, () => console.log('Paid API running on :3000'));
```

### Step 5: Use GOAT Network (Optional)

For GOAT x402 payments (BTC-backed stablecoins):

```typescript
const client = createPaymentClient({
  chains: ['goat-mainnet'],
  ows: { wallet: 'goat-agent' },
  goat: {
    apiKey: process.env.GOAT_API_KEY!,
    apiSecret: process.env.GOAT_API_SECRET!,
    merchantId: process.env.GOAT_MERCHANT_ID!,
  },
});

// Full GOAT lifecycle: createOrder → ERC-20 transfer → poll → proof → retry
const res = await client.fetchWithPayment('https://api.goat.network/data');
```

### Step 6: Discover Paid Services (Bazaar)

Find available paid APIs in the x402 ecosystem:

```typescript
import { createBazaarClient } from 'n-payment';

const bazaar = createBazaarClient({
  facilitatorUrl: 'https://x402.org/facilitator',  // or omit for mock catalog
});

// List all available services
const services = await bazaar.listServices({ type: 'http' });

// Search for specific services
const results = await bazaar.search('weather');
console.log(results.resources);
// → [{ resource: 'https://...', description: 'Weather data', accepts: [...] }]
```

### Step 7: Off-Ramp to Fiat (Optional)

Convert earned USDC to fiat currency:

```typescript
import { OffRampClient, MockMoonPayAdapter } from 'n-payment';

const offramp = new OffRampClient(new MockMoonPayAdapter());

// Get a quote
const quote = await offramp.getQuote({
  amount: '100',
  token: 'USDC',
  chain: 'base-sepolia',
  fiatCurrency: 'USD',
});
console.log(quote); // { fiatAmount: '99.50', feePercent: 0.5, estimatedDays: 2 }

// Execute withdrawal
const receipt = await offramp.withdraw({
  amount: '100',
  token: 'USDC',
  chain: 'base-sepolia',
  destination: { type: 'bank_account', id: 'acct_123' },
});
```

### Step 8: BTC Lending on GOAT (Advanced)

Lock BTC as collateral → borrow USDC → pay for services → repay:

```typescript
const client = createPaymentClient({
  chains: ['goat-mainnet'],
  ows: { wallet: 'btc-agent' },
  goat: { apiKey: '...', apiSecret: '...', merchantId: '...' },
  btcLending: {
    vaultAddress: '0xYourVaultContract',
    collateralRatio: 150,  // 150% collateral
  },
});

// Payment automatically uses BTC lending when configured
const res = await client.fetchWithPayment('https://api.goat.network/premium');
```

### Step 9: Agent Identity & Reputation (GOAT ERC-8004)

Register your agent on-chain and build reputation:

```typescript
import { GoatIdentity, OWSWallet } from 'n-payment';

const wallet = new OWSWallet({ wallet: 'my-agent' });
const identity = new GoatIdentity(wallet);

// Register agent
const txHash = await identity.registerAgent('https://my-agent.com/.well-known/agent.json');

// Give feedback to another agent
await identity.giveFeedback(42n, 5, 'https://api.example.com/data');

// Check reputation
const summary = await identity.getSummary(42n);
console.log(`Score: ${summary.sum} from ${summary.count} reviews`);
```

## Configuration Reference

### `createPaymentClient(config)`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `chains` | `ChainKey[]` | ✅ | Chains to support |
| `ows.wallet` | `string` | ✅ | OWS wallet name |
| `ows.privateKey` | `string` | — | Dev-only fallback key |
| `ows.autoFaucet` | `boolean` | — | Auto-fund on testnet |
| `protocol` | `'x402' \| 'mpp' \| 'auto'` | — | Protocol preference (default: `'auto'`) |
| `goat` | `GoatCredentials` | — | Required for GOAT chains |
| `btcLending` | `BtcLendingConfig` | — | BTC lending vault config |
| `analytics` | `{ plugins: AnalyticsPlugin[] }` | — | Custom analytics plugins |

### `createPaywall(config)`

| Option | Type | Description |
|--------|------|-------------|
| `routes` | `Record<string, PaywallRouteConfig>` | Route → pricing map (key format: `"METHOD /path"`) |
| `routes[].price` | `string` | Price in smallest token unit |
| `routes[].x402.payTo` | `string` | x402 payment recipient address |
| `routes[].mpp.currency` | `string` | MPP token contract address |
| `routes[].mpp.recipient` | `string` | MPP payment recipient address |

## Supported Chains

| Chain | Key | Protocol | Chain ID |
|-------|-----|----------|----------|
| Base Sepolia | `base-sepolia` | x402 | 84532 |
| Arbitrum Sepolia | `arbitrum-sepolia` | x402 | 421614 |
| Base | `base-mainnet` | x402 | 8453 |
| GOAT Testnet3 | `goat-testnet` | GOAT x402 | 48816 |
| GOAT Network | `goat-mainnet` | GOAT x402 | 2345 |
| Tempo Testnet | `tempo-testnet` | MPP | 42431 |
| Tempo | `tempo-mainnet` | MPP | 4217 |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  PaymentClient                       │
│  fetchWithPayment(url) → auto-detect → pay → retry │
├─────────────────────────────────────────────────────┤
│  X402Adapter  │  MppAdapter  │  GoatAdapter         │
├─────────────────────────────────────────────────────┤
│              OWSWallet (signing layer)               │
│         OWS CLI Driver │ privateKey fallback         │
├─────────────────────────────────────────────────────┤
│  BazaarClient │ OffRampClient │ GoatIdentity        │
└─────────────────────────────────────────────────────┘
```

## OWS Security Model

- Private keys encrypted at rest in OWS vault (`~/.ows/wallets/`)
- Policy engine evaluates every transaction before signing
- Keys decrypted only in signing path, wiped after use
- Agent never sees seeds, mnemonics, or raw key material

## Migration from v0.1

v0.2+ replaces `privateKey` with OWS wallet management:

```diff
  const client = createPaymentClient({
    chains: ['base-sepolia'],
-   privateKey: process.env.PRIVATE_KEY!,
+   ows: { wallet: 'my-agent' },
  });
```

## Peer Dependencies (Optional)

Install only what you need:

```bash
# For x402 protocol
npm install @x402/core @x402/evm @x402/fetch

# For MPP protocol (Tempo)
npm install mppx

# For OWS SDK (production)
npm install @open-wallet-standard/core
```

## License

MIT
