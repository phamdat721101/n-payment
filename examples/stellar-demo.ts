/**
 * Stellar v0.10 demo — three patterns in one file.
 *
 *   pnpm tsx examples/stellar-demo.ts charge-server   # paywall on :3001 (mock — no real Stellar)
 *   pnpm tsx examples/stellar-demo.ts charge-client   # buyer pays via n-payment
 *   pnpm tsx examples/stellar-demo.ts session         # 100 off-chain commitments
 *
 * Prereqs (charge-client only):
 *   STELLAR_SECRET=S...   (testnet wallet with USDC trustline + balance)
 *
 * Session demo runs entirely offline against a mocked channel id.
 */
import { createPaymentClient, StellarSessionClient } from '../src/index.js';

const PORT = 3001;

// ─── 1. Charge server: minimal paywall using n-payment middleware ─────────────

async function runChargeServer() {
  const express = (await import('express')).default;
  const { createPaywall, createHealthEndpoint } = await import('../src/index.js');
  const PAY_TO = process.env.STELLAR_RECIPIENT ?? 'GMERCHANT...';

  const config = {
    routes: {
      'GET /api/weather': {
        price: '10000', // 0.01 USDC (7 decimals on Stellar)
        description: 'Weather forecast — paid via Stellar x402',
        x402: { payTo: PAY_TO, network: 'stellar:testnet', asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA' },
      },
    },
  };

  const app = express();
  app.use(createPaywall(config) as any);
  app.get('/health', createHealthEndpoint(config) as any);
  app.get('/api/weather', (req, res) => {
    const refKey = req.headers['x-payment-reference-key'] ?? 'unknown';
    console.log(`[merchant] paid request received. referenceKey=${refKey}`);
    res.json({ city: 'Tokyo', temp: 22, refKey });
  });
  app.listen(PORT, () => console.log(`[merchant] Stellar paywall on http://localhost:${PORT}`));
}

// ─── 2. Charge client: buyer agent ────────────────────────────────────────────

async function runChargeClient() {
  const client = createPaymentClient({
    chains: ['stellar-testnet'],
    ows: { wallet: process.env.OWS_WALLET ?? 'demo-agent' },
    stellar: { secretKey: process.env.STELLAR_SECRET ?? '' },
  });
  const refKey = `STX-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[buyer] paying with referenceKey=${refKey}`);

  const res = await client.fetchWithPayment(`http://localhost:${PORT}/api/weather`, undefined, { referenceKey: refKey });
  console.log(`[buyer] status=${res.status} body=`, await res.json());

  const entries = client.getGuard()?.getAudit().queryByReferenceKey(refKey) ?? [];
  console.log(`[buyer] audit entries for ${refKey}: ${entries.length}`);
}

// ─── 3. Session: 100 off-chain commitments + 1 close (offline demo) ────────

async function runSession() {
  // Generate a deterministic commitment key for the demo.
  const commitmentSecretHex = '7f' + 'a'.repeat(62); // 64-char ed25519 seed
  const channel = 'CDEMOCHANNEL00000000000000000000000000000000000000000000000A';

  const session = new StellarSessionClient({
    channel,
    commitmentSecretHex,
    chainKey: 'stellar-testnet',
  });

  console.log('[session] signing 100 off-chain commitments at 0.001 USDC each');
  const start = Date.now();
  for (let i = 0; i < 100; i++) {
    await session.signCommitment(10_000n); // 0.001 USDC (7 decimals)
  }
  const elapsed = Date.now() - start;
  console.log(`[session] cumulative=${session.getCumulative()} units; ${elapsed}ms total`);
  console.log('[session] On real Stellar testnet: 1 on-chain close() settles all 100 payments in ~6 seconds.');
  console.log('[session] No per-payment on-chain transaction. Total fees: ~$0.00002 instead of 100×.');
}

// ─── Entry ────────────────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === 'charge-server') void runChargeServer();
else if (mode === 'charge-client') void runChargeClient();
else if (mode === 'session') void runSession();
else console.log('Usage: tsx examples/stellar-demo.ts <charge-server|charge-client|session>');
