# n-payment Integration Guide

## Installation

```bash
npm install n-payment
```

### Prerequisites

```bash
# Install OWS (Open Wallet Standard)
curl -fsSL https://docs.openwallet.sh/install.sh | bash
ows wallet create --name my-agent
ows fund deposit --wallet my-agent  # testnet faucet
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OWS_WALLET` | Yes | OWS wallet name |
| `CDP_API_KEY` | Mainnet only | Coinbase Developer Platform API key |
| `GOAT_API_KEY` | GOAT chains | GOAT Network API key |
| `GOAT_API_SECRET` | GOAT chains | GOAT Network API secret |
| `GOAT_MERCHANT_ID` | GOAT chains | GOAT merchant ID |

---

## 1. Buyer Integration — Pay for x402 Services

### Minimal Example

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-sepolia'],
  ows: { wallet: 'my-agent' },
});

const res = await client.fetchWithPayment('https://api.example.com/data');
const data = await res.json();
```

`fetchWithPayment()` handles the full 402 cycle: request → detect protocol → sign payment → retry with proof.

### With Service Discovery

```typescript
import { createPaymentClient, createBazaarClient } from 'n-payment';

// Discover services
const bazaar = createBazaarClient({
  facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
});
const result = await bazaar.search('weather');
const service = result.resources[0];

// Pay and consume
const client = createPaymentClient({
  chains: ['base-mainnet'],
  ows: { wallet: 'my-agent' },
});
const res = await client.fetchWithPayment(service.resource);
```

### With GOAT BTC Lending

```typescript
const client = createPaymentClient({
  chains: ['goat-mainnet'],
  ows: { wallet: 'goat-agent' },
  goat: { apiKey: '...', apiSecret: '...', merchantId: '...' },
  btcLending: { vaultAddress: '0x...', collateralRatio: 150 },
});
// Locks BTC → borrows USDC → pays → repays automatically
await client.fetchWithPayment('https://api.goat.network/data');
```

---

## 2. Seller Integration — Accept Crypto Payments

```typescript
import express from 'express';
import { createPaywall, createHealthEndpoint } from 'n-payment';

const app = express();

const config = {
  routes: {
    'GET /api/data': {
      price: '10000', // $0.01 USDC (6 decimals)
      description: 'Premium data endpoint',
      x402: { payTo: '0xYourAddress' },
    },
  },
};

app.use(createPaywall(config));
app.get('/health', createHealthEndpoint(config));
app.get('/api/data', (req, res) => res.json({ result: 'paid content' }));
app.listen(3000);
```

### Multi-Protocol (x402 + MPP)

```typescript
'GET /api/data': {
  price: '10000',
  x402: { payTo: '0xYourAddress' },
  mpp: { currency: '0x20c0...', recipient: '0xYourAddress' },
}
```

---

## 3. Agent Framework Integration

### Generic Pattern

```typescript
import { createPaymentClient, createBazaarClient } from 'n-payment';

const bazaar = createBazaarClient({ mockCatalog: true }); // or facilitatorUrl for mainnet
const client = createPaymentClient({ chains: ['base-sepolia'], ows: { wallet: 'my-agent' } });

// Agent tool: discover and pay
async function callPaidService(query: string) {
  const { resources } = await bazaar.search(query);
  if (!resources.length) throw new Error(`No service found for: ${query}`);
  return client.fetchWithPayment(resources[0].resource);
}
```

### LangChain Tool

```typescript
import { Tool } from 'langchain/tools';
import { createPaymentClient, createBazaarClient } from 'n-payment';

class PaidAPITool extends Tool {
  name = 'paid_api';
  description = 'Call a paid API service using x402 payment';
  private client = createPaymentClient({ chains: ['base-sepolia'], ows: { wallet: 'my-agent' } });
  private bazaar = createBazaarClient({ mockCatalog: true });

  async _call(query: string): Promise<string> {
    const { resources } = await this.bazaar.search(query);
    if (!resources.length) return 'No service found';
    const res = await this.client.fetchWithPayment(resources[0].resource);
    return JSON.stringify(await res.json());
  }
}
```

---

## 4. Off-Ramp Integration

```typescript
import { OffRampClient, MockMoonPayAdapter } from 'n-payment';

const offramp = new OffRampClient(new MockMoonPayAdapter());

// Get quote
const quote = await offramp.getQuote({
  amount: '100.00', token: 'USDC', chain: 'base-mainnet', fiatCurrency: 'USD',
});
console.log(`$100 USDC → $${quote.fiatAmount} USD`);

// Withdraw
const receipt = await offramp.withdraw({
  amount: '100.00', token: 'USDC', chain: 'base-mainnet',
  destination: { type: 'bank_account', id: 'bank-123' },
});
```

### Custom Adapter

```typescript
import type { OffRampAdapter } from 'n-payment';

class MyOffRampAdapter implements OffRampAdapter {
  readonly provider = 'my-provider';
  async getSupportedCurrencies() { return ['USD']; }
  async getQuote(params) { /* call your API */ }
  async withdraw(params) { /* call your API */ }
}
```

---

## 5. Configuration Reference

```typescript
interface NPaymentConfig {
  chains: ChainKey[];           // Required: ['base-sepolia'], ['base-mainnet', 'goat-mainnet']
  ows: { wallet: string };      // Required: OWS wallet name
  protocol?: 'x402'|'mpp'|'auto'; // Default: 'auto'
  goat?: GoatCredentials;       // Required for goat-* chains
  btcLending?: BtcLendingConfig; // Optional: BTC collateral
  analytics?: { plugins: AnalyticsPlugin[] };
}
```

### Supported Chains

| ChainKey | Chain ID | Protocol | Network |
|----------|----------|----------|---------|
| `base-sepolia` | 84532 | x402 | Testnet |
| `base-mainnet` | 8453 | x402 | Mainnet |
| `arbitrum-sepolia` | 421614 | x402 | Testnet |
| `goat-testnet` | 48816 | GOAT x402 | Testnet |
| `goat-mainnet` | 2345 | GOAT x402 | Mainnet |
| `tempo-testnet` | 2 | MPP | Testnet |

---

## 6. Testnet → Mainnet Migration

```diff
  const client = createPaymentClient({
-   chains: ['base-sepolia'],
+   chains: ['base-mainnet'],
    ows: { wallet: 'my-agent' },
  });
```

```diff
  const bazaar = createBazaarClient({
-   mockCatalog: true,
+   facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
  });
```

Checklist:
- [ ] Fund OWS wallet on mainnet
- [ ] Set `CDP_API_KEY` for mainnet facilitator
- [ ] Switch chain keys from `*-sepolia` to mainnet
- [ ] Update USDC contract addresses (automatic via chain config)
- [ ] Test with small amounts first

---

## 7. Error Handling

```typescript
import { NPaymentError, InsufficientBalanceError, AdapterNotFoundError } from 'n-payment';

try {
  await client.fetchWithPayment(url);
} catch (err) {
  if (err instanceof InsufficientBalanceError) {
    console.log('Fund wallet:', err.hint);
  } else if (err instanceof AdapterNotFoundError) {
    console.log('Wrong chain config:', err.hint);
  } else if (err instanceof NPaymentError) {
    console.log(`${err.code}: ${err.message}`);
  }
}
```

| Error | Code | When |
|-------|------|------|
| `NPaymentError` | Various | Base error class |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | Wallet can't cover payment |
| `AdapterNotFoundError` | `NO_ADAPTER` | No adapter for detected protocol |
| `ChallengeParseError` | `CHALLENGE_PARSE` | Malformed 402 response |
