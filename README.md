# n-payment

Multi-protocol payment SDK for Web3 agents. Unifies [x402](https://x402.org), [MPP](https://mpp.dev), and [GOAT x402](https://docs.goat.network/builders/x402) behind a single `fetchWithPayment()` call — secured by the [Open Wallet Standard (OWS)](https://docs.openwallet.sh).

**Private keys never leave the OWS vault.** Every transaction is policy-gated.

```
npm install n-payment
```

## Prerequisites

```bash
# 1. Install OWS
curl -fsSL https://docs.openwallet.sh/install.sh | bash

# 2. Create wallet
ows wallet create --name my-agent

# 3. Fund wallet (testnet)
ows fund deposit --wallet my-agent
```

## Quick Start — Client

```typescript
import { createPaymentClient } from 'n-payment';

const client = createPaymentClient({
  chains: ['base-sepolia'],
  ows: { wallet: 'my-agent' }, // OWS wallet — no private keys!
});

// Auto-detects x402 vs MPP from the 402 response
const res = await client.fetchWithPayment('https://api.example.com/data');
const data = await res.json();
```

## Quick Start — GOAT Network

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

// Full GOAT x402 lifecycle: createOrder → sign → poll → proof
const res = await client.fetchWithPayment('https://api.goat.network/data');
```

## Quick Start — Server

```typescript
import express from 'express';
import { createPaywall, createHealthEndpoint } from 'n-payment';

const app = express();
app.use(createPaywall({
  routes: {
    'GET /api/data': {
      price: '10000',
      x402: { payTo: '0xYourAddress' },
      mpp: { currency: '0x20c0...', recipient: '0xYourAddress' },
    },
  },
}));
app.get('/api/data', (req, res) => res.json({ result: 'paid content' }));
app.listen(3000);
```

## Migration from v0.1

v0.2 replaces `privateKey` with OWS wallet management:

```diff
  const client = createPaymentClient({
    chains: ['base-sepolia'],
-   privateKey: process.env.PRIVATE_KEY!,
+   ows: { wallet: 'my-agent' },
  });
```

## Supported Chains

| Chain | Protocol | Status |
|-------|----------|--------|
| Base Sepolia | x402 | ✅ |
| Arbitrum Sepolia | x402 | ✅ |
| GOAT Testnet3 | GOAT x402 | ✅ |
| GOAT Mainnet | GOAT x402 | ✅ |
| Tempo Testnet | MPP | ✅ |

## OWS Security Model

- Private keys encrypted at rest in OWS vault (`~/.ows/wallets/`)
- Policy engine evaluates every transaction before signing
- Keys decrypted only in signing path, wiped after use
- API keys scope agent access to specific wallets + policies
- Agent never sees seeds, mnemonics, or raw key material

## CLI Skills (Gstack Pattern)

```bash
# Pay for GOAT x402 API
./skills/pay-goat-x402.sh --wallet goat-agent --url https://api.goat.network/data

# All skills output structured JSON: { ok, data|error, code?, hint? }
```

## API

### `createPaymentClient(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `chains` | `ChainKey[]` | required | Chains to support |
| `ows` | `OWSConfig` | required | OWS wallet config |
| `ows.wallet` | `string` | required | OWS wallet name |
| `protocol` | `'x402' \| 'mpp' \| 'auto'` | `'auto'` | Protocol preference |
| `goat` | `GoatCredentials` | — | GOAT API credentials |
| `analytics` | `{ plugins: AnalyticsPlugin[] }` | console | Analytics plugins |

## License

MIT
