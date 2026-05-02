# n-payment — Secure Payment SDK for AI Agents

**AI agents need to pay for APIs and sell services across chains. Today that means handing agents raw private keys. We fix that.**

---

## Problem

Every builder shipping autonomous agents hits the same three walls:

1. **Key exposure** — agents hold raw private keys that leak into LLM context, logs, and memory
2. **Protocol fragmentation** — x402 on Base, MPP on Tempo, GOAT x402 on GOAT Network — each requires separate integration (500+ lines each)
3. **No guardrails** — nothing stops a rogue agent from draining a wallet. Spending limits live in application code that agents can bypass

## Solution

One call. Any protocol. Keys never touch the agent.

```typescript
const client = createPaymentClient({
  chains: ['base-sepolia', 'goat-mainnet', 'tempo-testnet'],
  ows: { wallet: 'my-agent' },  // OWS vault — keys encrypted, policy-gated
});

await client.fetchWithPayment('https://any-paid-api.com/data');
// auto-detects x402/MPP/GOAT → signs in vault → enforces policy → returns data
```

| Problem | n-payment |
|---------|-----------|
| Agent holds private key | Keys never leave OWS vault |
| No spending limits | Policy engine: daily caps, token allowlists, chain restrictions |
| One protocol per SDK | 3 protocols auto-detected (x402, MPP, GOAT x402) |
| One chain per integration | 5 chains, same wallet, same code |
| Server-side: pick one protocol | Dual-protocol paywall — advertise x402 + MPP, any client can pay |

## What's Built (v0.2.0)

- **OWSWallet** — policy-gated signing via Open Wallet Standard. Agent never sees keys.
- **Auto-detection** — inspects 402 headers, routes to correct protocol automatically
- **5 chains** — Base, Arbitrum, GOAT mainnet, GOAT testnet, Tempo
- **ERC-8004** — on-chain agent identity + reputation (GOAT Network)
- **CLI skills** — Gstack-compatible for Claude Code / Kiro CLI agents
- 27 tests, CJS+ESM+types, MIT licensed

## Why Now

The x402 Foundation launched with Google, OpenAI, Circle, Stripe, and Coinbase — 75M transactions/month. MoonPay shipped OWS v1.3 for secure agent wallets. HTTP-native payments are becoming the standard for agent-to-agent commerce. n-payment is the bridge that connects them all through one secure interface.

---

`@x402` `@OWS` `@Base` `@GOAT` `@MPP` `@ERC-8004`
