/**
 * Morph Network demo — three patterns in one file.
 *
 *   pnpm tsx examples/morph-demo.ts server     # merchant paywall on :3030
 *   pnpm tsx examples/morph-demo.ts client     # buyer agent pays with referenceKey
 *   pnpm tsx examples/morph-demo.ts bridge     # same code, Morph + Base
 *
 * Prereqs (server + client only): MORPH_ACCESS_KEY, MORPH_SECRET_KEY env vars.
 * Register at https://morph-rails.morph.network/x402.
 */
import express from 'express';
import { createPaymentClient, createPaywall, createHealthEndpoint } from '../src/index.js';

const PORT = 3030;
const PAY_TO = process.env.PAY_TO ?? '0x0000000000000000000000000000000000000001';

// ─── 1. Merchant: paywalled API selling weather data on Morph ──────────────────

function runServer() {
  const app = express();
  const config = {
    routes: {
      'GET /api/weather': {
        price: '10000', // 0.01 USDC (6 decimals)
        description: 'Weather forecast — paid via Morph x402',
        morph: { payTo: PAY_TO, network: 'eip155:2818' },
      },
    },
  };

  app.use(createPaywall(config) as any);
  app.get('/health', createHealthEndpoint(config) as any);
  app.get('/api/weather', (req, res) => {
    const refKey = req.headers['x-payment-reference-key'] ?? 'unknown';
    console.log(`[merchant] paid request received. referenceKey=${refKey}`);
    res.json({ city: 'Tokyo', temp: 22, refKey });
  });

  app.listen(PORT, () => console.log(`[merchant] Morph paywall on http://localhost:${PORT}`));
}

// ─── 2. Buyer: agent that pays with a per-order reference key ──────────────────

async function runClient() {
  const client = createPaymentClient({
    chains: ['morph-mainnet'],
    ows: { wallet: process.env.OWS_WALLET ?? 'demo-agent' },
    morph: {
      accessKey: process.env.MORPH_ACCESS_KEY ?? '',
      secretKey: process.env.MORPH_SECRET_KEY ?? '',
    },
    policy: { maxPerTransaction: 100_000n, maxPerDay: 10_000_000n },
  });

  const referenceKey = `ORD-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[buyer] paying with referenceKey=${referenceKey}`);

  const res = await client.fetchWithPayment(`http://localhost:${PORT}/api/weather`, undefined, { referenceKey });
  console.log(`[buyer] status=${res.status} body=`, await res.json());

  // Reconciliation — query audit log for this order
  const entries = client.getGuard()?.getAudit().queryByReferenceKey(referenceKey) ?? [];
  console.log(`[buyer] audit entries for ${referenceKey}: ${entries.length}`);
}

// ─── 3. Cross-protocol bridge: same agent code, Morph + Base ──────────────────

async function runBridge() {
  const client = createPaymentClient({
    chains: ['morph-mainnet', 'base-mainnet'],
    ows: { wallet: process.env.OWS_WALLET ?? 'bridge-agent' },
    morph: { accessKey: process.env.MORPH_ACCESS_KEY ?? '', secretKey: process.env.MORPH_SECRET_KEY ?? '' },
  });
  console.log('[bridge] one client, two chains. fetchWithPayment auto-routes per 402 challenge network.');
  console.log('[bridge] adapters wired:', (client as any).adapters?.map((a: any) => a.protocol));
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === 'server') runServer();
else if (mode === 'client') void runClient();
else if (mode === 'bridge') void runBridge();
else console.log('Usage: tsx examples/morph-demo.ts <server|client|bridge>');
