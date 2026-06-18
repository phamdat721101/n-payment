/**
 * XRPL x402 round-trip — RLUSD on testnet via the T54 hosted facilitator.
 *
 * Run:
 *   XRPL_BUYER_SEED=sEd...funded-testnet-wallet pnpm tsx examples/xrpl-x402-rlusd.ts
 *
 * What it does, in order:
 *   1. Stand up an Express server with createPaywall({ '/paid': { xrpl: {...} } }).
 *   2. Build a PaymentClient configured for xrpl-testnet.
 *   3. fetchWithPayment('http://localhost:PORT/paid') — the SDK auto-handles
 *      the 402, presigns a Payment, retries with PAYMENT-SIGNATURE, and the
 *      merchant settles via xrpl-facilitator-testnet.t54.ai.
 *   4. Print the settled XRPL tx hash so you can look it up at livenet.xrpl.org.
 *
 * Prereqs (one-time):
 *   - A funded XRPL testnet account (faucet: https://xrpl.org/resources/dev-tools/xrp-faucets)
 *   - A trust line to the testnet RLUSD issuer (rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV).
 *     The SDK auto-creates this on first call if missing.
 *   - At least 0.01 RLUSD on the buyer (or set xrpl.autoSwap=true to swap from XRP).
 */

import express from 'express';
import { createPaymentClient, createPaywall } from '../src/index.js';
import { Wallet } from 'xrpl';

const PORT = Number(process.env.PORT ?? 8765);
const SEED = process.env.XRPL_BUYER_SEED;
if (!SEED) {
  console.error('Set XRPL_BUYER_SEED to a funded testnet seed (sEd...). See https://xrpl.org/resources/dev-tools/xrp-faucets');
  process.exit(1);
}

const buyer = Wallet.fromSeed(SEED);
const merchantPayTo = process.env.XRPL_MERCHANT_PAY_TO ?? buyer.classicAddress;

// ── Merchant side ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(
  createPaywall({
    routes: {
      'GET /paid': {
        price: '0.01', // 0.01 RLUSD
        description: 'XRPL x402 demo endpoint',
        xrpl: {
          payTo: merchantPayTo,
          network: 'xrpl:1',
          asset: 'RLUSD',
          // facilitatorUrl omitted -> defaults to xrpl-facilitator-testnet.t54.ai
        },
      },
    },
  }),
);
app.get('/paid', (_req, res) => res.json({ message: 'Hello! Thanks for the 0.01 RLUSD.' }));

const server = app.listen(PORT, async () => {
  console.log(`merchant   listening at http://localhost:${PORT}/paid`);
  console.log(`buyer      ${buyer.classicAddress}`);
  console.log(`merchant   ${merchantPayTo}`);

  try {
    // ── Buyer side ─────────────────────────────────────────────────────────────
    const client = createPaymentClient({
      chains: ['xrpl-testnet'],
      ows: { wallet: 'demo-buyer' }, // OWS wallet name (unused since we set xrpl.seed below)
      xrpl: { seed: SEED, autoSwap: true },
    });

    const t0 = Date.now();
    const res = await client.fetchWithPayment(`http://localhost:${PORT}/paid`);
    const dt = Date.now() - t0;

    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${await res.text()}`);
      return;
    }
    const body = await res.json();
    console.log(`\n✓ HTTP ${res.status} in ${dt}ms`);
    console.log(`  body: ${JSON.stringify(body)}`);

    const settle = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('payment-response');
    if (settle) {
      const decoded = JSON.parse(Buffer.from(settle, 'base64').toString());
      console.log(`  txhash:   ${decoded.transaction}`);
      console.log(`  network:  ${decoded.network}`);
      console.log(`  payer:    ${decoded.payer}`);
      console.log(`  explorer: https://testnet.xrpl.org/transactions/${decoded.transaction}`);
    }
  } catch (err) {
    console.error('e2e failed:', (err as Error).message);
  } finally {
    server.close();
  }
});
