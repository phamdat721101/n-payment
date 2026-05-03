# The Missing Pieces: Crypto-to-Fiat Exchange

## Problem : No Crypto-to-Fiat Exchange Flow

### The core problem

When someone receives crypto — whether a merchant accepting USDC for coffee, an API provider earning from x402 payments, or a freelancer paid in stablecoins — the money is stuck on-chain. The SDK has no mechanism to convert crypto to fiat currency. You can't pay rent, buy groceries, or pay employees with on-chain USDC.

This is the **crypto-to-fiat exchange problem**. It's the single biggest blocker to real-world crypto payment adoption, and it affects every chain the SDK supports.

### Why "just sell it on an exchange" doesn't work

The naive answer is "send it to an exchange and sell." In practice, this breaks down at every level:

#### Path 1: Centralized exchange (Binance, Coinbase, etc.)

The user sends USDC to an exchange, sells for fiat, withdraws to bank.

**Why this fails for real users:**
- Requires KYC/AML verification — days to weeks of waiting, ID documents, selfies
- Withdrawal fees eat into small amounts ($5-25 per withdrawal)
- Not instant — bank transfers take 1-3 business days
- Requires a CEX account, which most small merchants and normal users don't have
- Not programmable — can't be automated by an SDK or triggered by an agent
- Regulatory complexity — different exchanges available in different countries

A merchant doing $5-50 transactions can't afford to wait 3 days and pay $15 in fees to cash out each payment.

#### Path 2: OTC desk (Binance OTC, Circle OTC, Cumberland)

Large-volume traders use over-the-counter desks to swap crypto for fiat at negotiated rates.

**Why this is irrelevant for most users:**
- Minimum trade sizes of $10K-100K+
- Only available to institutional clients with credit agreements
- Requires a relationship manager and onboarding process
- Settlement takes hours to days
- Completely inaccessible to a coffee shop, a freelancer, or an AI agent

OTC desks solve the liquidity problem for whales and institutions. They don't solve it for the 99% of users who need to convert $5-500 at a time.

#### Path 3: Peer-to-peer (LocalBitcoins model)

Find someone locally who wants to buy your crypto and pay you cash.

**Why this doesn't scale:**
- Requires finding a counterparty for every transaction
- No price guarantee — you negotiate each trade
- Safety risk for in-person cash trades
- No recourse if the counterparty doesn't pay
- Can't be automated or integrated into an SDK

#### Path 4: DEX swap (Uniswap, SushiSwap)

Swap USDC for ETH or another token on a decentralized exchange.

**Why this doesn't solve the problem:**
- DEX swaps convert between crypto assets (USDC→ETH, BTC→USDT)
- They do NOT convert crypto to fiat
- After the swap, you still have crypto in your wallet
- The BTC lending vault in n-payment v0.3 is an example: it converts BTC→USDC for on-chain payments, but the USDC stays on-chain

A DEX is a tool for moving between crypto assets. It's not an off-ramp to the real economy.

### What's actually needed: a fiat rail

Converting crypto to cash requires a **fiat rail** — a licensed connection to the banking system. Someone with a money transmitter license who can:

1. Accept your crypto
2. Sell it on their own liquidity pool
3. Initiate a bank transfer, card deposit, or mobile money payment to your account

Only a handful of companies provide this as an API:

| Provider | Coverage | Payout Methods | Min Amount | Fees |
|----------|----------|----------------|------------|------|
| MoonPay | 160+ countries | Bank, card | ~$20 | 1-3% |
| Transak | 170+ countries | Bank, card, Visa Direct | ~$30 | 1-5% |
| Spritz | US, EU | Bank (ACH, SEPA) | $1 | 0.5-1% |
| Circle Payments Network | Global (via partners) | Bank (SWIFT, local rails) | Varies | Varies |

These providers handle the regulatory burden (money transmitter licenses, KYC/AML compliance, banking relationships) so that an SDK doesn't have to.

### What the SDK is missing, specifically

1. **No `OffRampAdapter` interface** — the SDK has `PaymentAdapter` for paying, but nothing for cashing out. There's no abstraction for "convert my crypto balance to fiat."

2. **No provider integrations** — no MoonPay, Transak, or Spritz adapter. The SDK can sign transactions and send crypto, but it can't initiate a fiat conversion.

3. **No quote system** — no way to ask "how much USD/EUR/VND will I get for 100 USDC?" before committing. Users need to see the exchange rate and fees before they convert.

4. **No withdrawal flow** — no way to initiate a crypto-to-fiat conversion programmatically. The full flow would be: get quote → approve amount → send crypto to provider → track status → receive fiat.

5. **No fiat destination management** — no way to store or manage bank accounts, card details, or mobile money numbers. The merchant needs to register their payout destination once and reuse it.

6. **No multi-currency support** — the SDK thinks in terms of crypto tokens (USDC, USDT, WBTC). It has no concept of fiat currencies (USD, EUR, VND, THB) or exchange rates between them.

### The liquidity gap visualized

```
Current SDK — money flows on-chain but never exits to fiat:

  Agent wallet ──USDC──→ API provider wallet
  Customer wallet ──USDC──→ Merchant wallet    (with QR, Problem 1)
                                    │
                                    ▼
                              USDC sits here
                              forever on-chain
                                    │
                                    ✗ No path to fiat
                                    ✗ Can't pay rent
                                    ✗ Can't buy supplies
                                    ✗ Can't pay employees


What's needed — complete payment loop with fiat exit:

  Agent wallet ──USDC──→ API provider wallet ──→ Off-ramp API ──→ Bank account
  Customer wallet ──USDC──→ Merchant wallet ──→ Off-ramp API ──→ Bank account
                                                      │
                                                      ▼
                                              Provider handles:
                                              • Liquidity (buys your USDC)
                                              • Compliance (KYC/AML)
                                              • Banking rail (SWIFT/ACH/SEPA)
                                              • Currency conversion (USDC → USD/EUR/VND)
```

### Why this can't be built from scratch

An SDK cannot become a money transmitter. The off-ramp requires:

- **Money transmitter licenses** in every jurisdiction you operate (50 US states, EU, UK, SEA, etc.)
- **Banking relationships** to initiate wire transfers, ACH, SEPA, Faster Payments
- **Liquidity pools** to buy crypto from users at market rates
- **KYC/AML infrastructure** to verify user identity and screen transactions
- **Compliance reporting** to regulators in each jurisdiction

This is why the solution is an **adapter pattern** — the SDK defines the interface (`OffRampAdapter`), ships adapters for existing licensed providers (MoonPay, Transak), and lets developers plug in custom providers for their market.

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
| Exchange crypto to fiat | ❌ Missing | `OffRampAdapter` interface + provider integrations |
| Quote crypto→fiat rate | ❌ Missing | Multi-currency quote API |
| Withdraw to bank/card | ❌ Missing | Withdrawal flow with status tracking |
| Manage fiat destinations | ❌ Missing | Bank account / card registration |

---

## Technical References

- **ERC-681**: [eips.ethereum.org/EIPS/eip-681](https://eips.ethereum.org/EIPS/eip-681) — URI format for transaction requests
- **erc681.org**: [erc681.org](https://www.erc681.org/) — wallet adoption tracker and QR builder
- **MoonPay Ramps API**: [moonpay.com/business/ramps](https://www.moonpay.com/business/ramps) — on/off-ramp in one integration
- **Transak Off-Ramp**: [docs.transak.com/docs/transak-off-ramp](https://docs.transak.com/docs/transak-off-ramp) — sell crypto, receive fiat
- **Spritz Finance**: [spritz.finance](https://spritz.finance) — crypto-to-fiat API for developers
- **Circle Nanopayments**: [developers.circle.com/gateway/nanopayments](https://developers.circle.com/gateway/nanopayments) — gas-free USDC payments
- **Circle Payments Network**: [developers.circle.com/cpn](https://developers.circle.com/cpn) — cross-border fiat settlement