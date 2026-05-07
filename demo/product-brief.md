# n-payment — Secure Payment SDK for AI Agents & Merchants

**AI agents need to pay for APIs. Merchants need to accept crypto at the counter. Both need off-ramps to fiat. One SDK handles all three — keys never touch the agent.**

---

## Problem

Every builder shipping autonomous agents or crypto-accepting merchants hits the same walls:

1. **Key exposure** — agents hold raw private keys that leak into LLM context, logs, and memory
2. **Protocol fragmentation** — x402 on Base, MPP on Tempo, GOAT x402 on GOAT Network — each requires separate integration (500+ lines each)
3. **No guardrails** — nothing stops a rogue agent from draining a wallet
4. **Idle stablecoin exposure** — BTC holders must swap to USDC before agents can transact
5. **No QR scan-to-pay** — the SDK handles agent-to-API flows but can't generate a QR code for a customer to scan and pay at a merchant
6. **No off-ramp** — merchants receiving USDC have no path to convert to fiat (bank, card, mobile money) within the SDK

Problems 1–4 are solved in v0.3. Problems 5–6 are the v0.4 roadmap — the "last mile" from crypto balance to real-world commerce.

## Solution

### v0.3 — Agent Payments (Shipped)

One call. Any protocol. Keys never touch the agent. BTC as collateral.

```typescript
const client = createPaymentClient({
  chains: ['goat-testnet'],
  ows: { wallet: 'my-agent' },
  goat: { apiKey, apiSecret, merchantId },
  btcLending: { vaultAddress: '0x...', collateralRatio: 150 },
});

await client.fetchWithPayment('https://any-paid-api.com/data');
// auto-detects protocol → locks BTC → borrows USDC → pays → repays → returns data
```

### v0.4 — QR Scan-to-Pay + Off-Ramp (Next)

Merchants generate QR codes. Customers scan and pay with crypto. Merchants cash out to fiat.

```typescript
import { createPaymentRequest, createOffRamp } from 'n-payment';

// ─── Merchant: generate QR code ──────────────────────────────────────────────
const request = createPaymentRequest({
  merchant: '0xMerchantAddress',
  amount: '5.00',           // $5.00 USDC
  token: 'USDC',
  chain: 'goat-testnet',
  label: 'Coffee Shop',
  memo: 'Order #1234',
});

request.toQRCode();         // → PNG data URL (scannable by any ERC-681 wallet)
request.toURI();            // → ethereum:0xUSDC@2345/transfer?address=0xMerchant&uint256=5e6
request.toDeepLink();       // → opens wallet app directly

// ─── Customer: scan QR and pay ───────────────────────────────────────────────
const client = createPaymentClient({ chains: ['goat-testnet'], ows: { wallet: 'my-wallet' } });
const receipt = await client.payRequest(request.toURI());
// OWS-signed ERC-20 transfer → tx confirmed → receipt with txHash

// ─── Merchant: off-ramp to fiat ──────────────────────────────────────────────
const offramp = createOffRamp({
  provider: 'moonpay',      // or 'transak', 'spritz', custom
  apiKey: process.env.MOONPAY_KEY,
});

const cashout = await offramp.withdraw({
  amount: '5.00',
  token: 'USDC',
  chain: 'goat-testnet',
  destination: { type: 'bank_account', id: 'merchant-bank-id' },
});
// USDC → fiat in merchant's bank account
```

## Architecture: The Full Payment Loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                        n-payment SDK                                │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Agent-to-API │  │ QR Scan-to-  │  │ Off-Ramp / Cash          │  │
│  │ (v0.3 ✅)    │  │ Pay (v0.4)   │  │ Facilitator (v0.4)       │  │
│  │              │  │              │  │                          │  │
│  │ x402         │  │ ERC-681 URI  │  │ OffRampAdapter interface │  │
│  │ MPP          │  │ QR generate  │  │ ├─ MoonPayAdapter        │  │
│  │ GOAT x402    │  │ QR scan/pay  │  │ ├─ TransakAdapter        │  │
│  │ BTC lending  │  │ Deep links   │  │ └─ Custom adapters       │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────────┘  │
│         │                 │                      │                  │
│         └─────────────────┼──────────────────────┘                  │
│                           │                                         │
│                    ┌──────┴──────┐                                   │
│                    │  OWS Wallet │  ← policy-gated signing          │
│                    │  (keys in   │  ← spending limits               │
│                    │   vault)    │  ← token allowlists              │
│                    └─────────────┘                                   │
└─────────────────────────────────────────────────────────────────────┘
```

### The Three Flows

| Flow | Trigger | Payer | Receiver | Settlement | Off-Ramp |
|------|---------|-------|----------|------------|----------|
| **Agent-to-API** | HTTP 402 | AI agent | API provider | On-chain USDC | N/A (digital service) |
| **QR Scan-to-Pay** | QR code scan | Human/agent wallet | Merchant | On-chain USDC via ERC-681 | Optional |
| **Off-Ramp** | Merchant request | n/a | Merchant bank | USDC → fiat via facilitator | MoonPay/Transak/custom |

## QR Payment: How It Works

### Standard: ERC-681

ERC-681 defines the `ethereum:` URI format for payment requests. Every major wallet (MetaMask, Coinbase Wallet, Trust Wallet, Rainbow) supports scanning these QR codes.

**Native ETH payment:**
```
ethereum:0xMerchant?value=2.014e18
```

**ERC-20 token payment (USDC on GOAT Network):**
```
ethereum:0xUSDCContract@2345/transfer?address=0xMerchant&uint256=5000000
```

The `@2345` is the GOAT mainnet chain ID. The `/transfer` calls the ERC-20 `transfer(address,uint256)` function.

### QR Payment Flow

```
1. Merchant creates payment request
   → createPaymentRequest({ amount: '5.00', token: 'USDC', chain: 'goat-testnet' })

2. SDK generates ERC-681 URI + QR code
   → ethereum:0xUSDC@2345/transfer?address=0xMerchant&uint256=5e6

3. Customer scans QR with any wallet
   → Wallet pre-fills: send 5 USDC to merchant on GOAT Network

4. Customer confirms payment
   → ERC-20 transfer signed and broadcast

5. SDK polls for confirmation
   → tx confirmed on-chain, receipt generated

6. (Optional) Merchant off-ramps
   → USDC → fiat via MoonPay/Transak
```

### Why ERC-681 + OWS

- **Universal compatibility** — any ERC-681 wallet can scan the QR. No proprietary app needed.
- **OWS policy on payer side** — if the customer uses n-payment SDK, spending limits and token allowlists apply
- **Chain-aware** — `@chainId` in the URI routes to the correct network automatically
- **Token-aware** — USDC, USDT, WBTC, PegBTC all supported via the `/transfer` function call format

## Off-Ramp: Facilitator-Agnostic Design

### The `OffRampAdapter` Interface

Following the same SOLID pattern as `PaymentAdapter`, the off-ramp uses an adapter interface:

```typescript
interface OffRampAdapter {
  readonly provider: string;
  getSupportedCurrencies(): Promise<string[]>;
  getQuote(params: OffRampQuoteParams): Promise<OffRampQuote>;
  withdraw(params: OffRampWithdrawParams): Promise<OffRampReceipt>;
}

interface OffRampQuoteParams {
  amount: string;
  token: string;
  chain: ChainKey;
  fiatCurrency: string;    // 'USD', 'EUR', 'VND', etc.
}

interface OffRampWithdrawParams {
  amount: string;
  token: string;
  chain: ChainKey;
  destination: { type: 'bank_account' | 'card' | 'mobile_money'; id: string };
}
```

### Shipped Adapters

| Adapter | Provider | Coverage | Payout Methods |
|---------|----------|----------|----------------|
| `MoonPayAdapter` | MoonPay | 160+ countries | Bank, card |
| `TransakAdapter` | Transak | 170+ countries | Bank, card, Visa Direct |
| Custom | Any | Implement `OffRampAdapter` | Any |

### Off-Ramp Flow

```
Merchant receives USDC on GOAT Network
  → offramp.getQuote({ amount: '100', token: 'USDC', fiatCurrency: 'USD' })
  → Quote: $99.50 USD (0.5% fee), arrives in 1-2 business days
  → offramp.withdraw({ amount: '100', destination: { type: 'bank_account', id: '...' } })
  → USDC transferred to facilitator → fiat deposited to merchant bank
```

## What's Built vs What's Next

| Feature | v0.3 (Shipped) | v0.4 (Next) |
|---------|---------------|-------------|
| Agent-to-API payments (x402, MPP, GOAT) | ✅ | ✅ |
| OWS wallet (policy-gated, no key exposure) | ✅ | ✅ |
| BTC lending (lock BTC → borrow USDC → pay) | ✅ | ✅ |
| ERC-8004 agent identity + reputation | ✅ | ✅ |
| 5 chains, 4 token types | ✅ | ✅ |
| **QR code generation (ERC-681)** | ❌ | ✅ |
| **QR scan-to-pay (customer side)** | ❌ | ✅ |
| **Payment request creation** | ❌ | ✅ |
| **Off-ramp adapter interface** | ❌ | ✅ |
| **MoonPay off-ramp adapter** | ❌ | ✅ |
| **Transak off-ramp adapter** | ❌ | ✅ |
| **Merchant dashboard** | ❌ | v0.5 |

## Traction

- **50 developers** testing the SDK on GOAT Network
- **38 tests** across 3 suites, CJS+ESM+types, MIT licensed
- **5 chains** — Base, Arbitrum, GOAT mainnet, GOAT testnet, Tempo
- **4 protocols** — x402, MPP, GOAT x402, ERC-681 (v0.4)
- **Full demo server** with BTC lending simulation, OWS wallet USP, payment analytics

## Why Now

- x402 Foundation (Google, OpenAI, Circle, Stripe, Coinbase) — 75M tx/month
- Circle Nanopayments live on mainnet (April 2026) — gas-free USDC payments
- MoonPay OWS v1.3 for secure agent wallets
- GOAT Network BTC Yield Dashboard with BTC Lending
- ERC-681 adoption accelerating — erc681.org tracking wallet support
- Visa Direct integration with Transak — real-time crypto-to-card payouts

The payment loop is closing. n-payment is the SDK that connects all the pieces.

---

`@x402` `@OWS` `@Base` `@GOAT` `@MPP` `@ERC-8004` `@BTC-Lending` `@ERC-681` `@QR-Pay` `@Off-Ramp`
