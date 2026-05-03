# The Two Missing Pieces: QR Payments and Liquidity Off-Ramp

## Problem 1: No QR Code Payment Support

### What's missing

The SDK has no way to generate a payment request that a human can scan with a phone. Every payment in the current SDK starts with an HTTP 402 response from a server. There is no entry point for a physical-world payment.

Look at the `PaymentAdapter` interface:

```typescript
interface PaymentAdapter {
  readonly protocol: string;
  detect(response: Response): boolean;
  pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response>;
}
```

Every adapter takes an HTTP `Response` as input. The `detect()` method reads HTTP headers. The `pay()` method retries an HTTP request. The entire abstraction assumes the payment starts with a server returning 402.

A coffee shop can't return a 402 response. A street vendor doesn't have an API endpoint. A parking meter doesn't speak HTTP.

### What the SDK is missing, specifically

1. **No `PaymentRequest` class** — nothing generates an ERC-681 URI from a merchant address + amount + token + chain
2. **No QR code generation** — no function that takes a payment request and returns a scannable image
3. **No `payRequest()` method on `PaymentClient`** — the client can only `fetchWithPayment(url)`, it can't pay an ERC-681 URI directly
4. **No payment confirmation polling** — after a QR payment, the merchant needs to know the tx confirmed. The SDK has `GoatX402Client.pollUntilTerminal()` for GOAT orders, but nothing for a raw ERC-20 transfer
5. **No deep link support** — on mobile, the QR code should open the wallet app directly via `ethereum:` URI scheme

### The gap in the architecture

```
Current SDK flow (agent-to-API only):

  HTTP 402 ──→ detect protocol ──→ sign payment ──→ retry request
     ↑                                                    │
  server returns 402                              agent gets data


Missing flow (QR scan-to-pay):

  QR code ──→ parse ERC-681 URI ──→ sign payment ──→ confirm on-chain
     ↑                                                    │
  merchant displays QR                          merchant gets receipt
```

The SDK has the signing infrastructure (OWS wallet), the chain registry (5 chains, 4 tokens), and the policy engine (spending limits, token allowlists). What it lacks is the **entry point** — the ability to create and consume a payment request that doesn't come from an HTTP 402 response.

---

## Problem 2: No Liquidity Off-Ramp

### What's missing

When a merchant receives USDC on GOAT Network, the money is stuck on-chain. The SDK has no mechanism to convert crypto to fiat currency. The merchant can't pay rent, buy supplies, or pay employees with on-chain USDC.

This is the **off-ramp problem**, and it's the single biggest blocker to real-world crypto payment adoption.

### Why this is harder than it looks

Converting crypto to cash requires **liquidity** — someone willing to buy your USDC and give you dollars, euros, or dong. There are only a few ways to get this liquidity:

#### Option A: Centralized exchange (CEX)

The merchant sends USDC to Binance/Coinbase, sells for fiat, withdraws to bank.

**Problems:**
- Requires KYC/AML verification (days to weeks)
- Withdrawal fees ($5-25 per withdrawal)
- Not instant — bank transfers take 1-3 business days
- The merchant needs a CEX account, which most small merchants don't have
- Not programmable — can't be automated by an SDK

#### Option B: OTC desk

Large-volume traders use over-the-counter desks to swap crypto for fiat. Binance OTC, Circle OTC, Cumberland.

**Problems:**
- Minimum trade sizes ($10K-100K+)
- Only available to institutional clients
- Requires relationship and credit agreements
- Completely irrelevant for a coffee shop doing $5 transactions

#### Option C: Off-ramp API providers

Services like MoonPay, Transak, and Spritz provide APIs that accept crypto and deposit fiat to bank accounts or cards.

**This is the viable path for an SDK**, but it requires:
- Integration with at least one provider's API
- KYC flow for the merchant (one-time)
- Quote fetching (exchange rate + fees)
- Transaction submission (send USDC to provider, receive fiat)
- Status tracking (pending → completed → deposited)

### What the SDK is missing, specifically

1. **No `OffRampAdapter` interface** — the SDK has `PaymentAdapter` for paying, but nothing for cashing out
2. **No provider integrations** — no MoonPay, Transak, or Spritz adapter
3. **No quote system** — no way to ask "how much USD will I get for 100 USDC?"
4. **No withdrawal flow** — no way to initiate a crypto-to-fiat conversion
5. **No fiat destination management** — no way to store/manage bank accounts or card details

### The liquidity gap visualized

```
Current SDK — money flows IN but never OUT:

  Agent wallet ──USDC──→ API provider wallet
  Customer wallet ──USDC──→ Merchant wallet    (with QR, Problem 1)
                                    │
                                    ▼
                              USDC sits here
                              forever on-chain
                                    │
                                    ✗ No path to fiat


What's needed — complete payment loop:

  Agent wallet ──USDC──→ API provider wallet ──→ Off-ramp ──→ Bank account
  Customer wallet ──USDC──→ Merchant wallet ──→ Off-ramp ──→ Bank account
```

### Why you can't just "add a DEX"

A common suggestion is to integrate a decentralized exchange (Uniswap, SushiSwap) to swap tokens. This solves a different problem — it converts between crypto assets (BTC→USDC, ETH→USDT). It does NOT convert crypto to fiat.

The off-ramp requires a **fiat rail** — a connection to the banking system. Only licensed money transmitters (MoonPay, Transak, Circle) can provide this. An SDK can't build this from scratch; it needs to integrate with existing providers.

---

## How These Two Problems Connect

The QR payment problem and the off-ramp problem are two halves of the same gap: **the SDK can move money on-chain but can't bridge to the physical economy**.

```
Physical world                    On-chain                     Physical world
─────────────                    ────────                     ─────────────
Customer has                     USDC moves                   Merchant needs
cash/card/crypto  ──→  ???  ──→  from wallet  ──→  ???  ──→   cash in bank
                       ↑         to wallet         ↑
                  QR Payment              Off-Ramp
                  (Problem 1)             (Problem 2)
```

Solving only Problem 1 (QR) without Problem 2 (off-ramp) means merchants can accept crypto but can't use it. Solving only Problem 2 without Problem 1 means merchants can cash out but have no way to receive payments from walk-in customers.

Both must be solved together to close the loop.

## Summary of Gaps

| Capability | Current State | What's Needed |
|-----------|--------------|---------------|
| Agent pays API (x402/MPP/GOAT) | ✅ Works | — |
| BTC collateral lending | ✅ Works | — |
| OWS policy-gated signing | ✅ Works | — |
| ERC-8004 agent identity | ✅ Works | — |
| Generate QR payment request | ❌ Missing | ERC-681 URI builder + QR encoder |
| Scan QR and pay | ❌ Missing | `payRequest()` method on PaymentClient |
| Confirm QR payment on-chain | ❌ Missing | Transaction receipt polling |
| Off-ramp to fiat | ❌ Missing | `OffRampAdapter` interface + provider integrations |
| Quote crypto→fiat rate | ❌ Missing | Quote API integration |
| Withdraw to bank/card | ❌ Missing | Withdrawal flow with status tracking |

---

## Technical References

- **ERC-681**: [eips.ethereum.org/EIPS/eip-681](https://eips.ethereum.org/EIPS/eip-681) — URI format for transaction requests
- **erc681.org**: [erc681.org](https://www.erc681.org/) — wallet adoption tracker and QR builder
- **MoonPay Ramps API**: [moonpay.com/business/ramps](https://www.moonpay.com/business/ramps) — on/off-ramp in one integration
- **Transak Off-Ramp**: [docs.transak.com/docs/transak-off-ramp](https://docs.transak.com/docs/transak-off-ramp) — sell crypto, receive fiat
- **Circle Nanopayments**: [developers.circle.com/gateway/nanopayments](https://developers.circle.com/gateway/nanopayments) — gas-free USDC payments
- **Circle Paymaster**: [developers.circle.com/stablecoins/paymaster-overview](https://developers.circle.com/stablecoins/paymaster-overview) — pay gas in USDC