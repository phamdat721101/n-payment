/**
 * Morph Network demo — four patterns in one file.
 *
 *   pnpm tsx examples/morph-demo.ts server     # merchant paywall on :3030 (mainnet, scheme=exact)
 *   pnpm tsx examples/morph-demo.ts client     # buyer agent pays with referenceKey
 *   pnpm tsx examples/morph-demo.ts bridge     # same code, Morph + Base
 *   pnpm tsx examples/morph-demo.ts hoodi      # full e2e on Hoodi: merchant + facilitator + buyer
 *
 * Prereqs (server + client only): MORPH_ACCESS_KEY, MORPH_SECRET_KEY env vars.
 * Prereqs (hoodi mode):
 *   MORPH_HOODI_SPONSOR_KEY  — sponsor account funded with Hoodi ETH (pays gas)
 *   OWS_PRIVATE_KEY          — buyer account funded with Hoodi USDC (signs auth)
 *
 * Register at https://morph-rails.morph.network/x402 (mainnet only).
 */
import express from 'express';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAINS, createMorphHoodiFacilitator, createPaymentClient,
  createPaywall, createHealthEndpoint,
} from '../src/index.js';

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

// ─── 4. Hoodi e2e: merchant + custom facilitator + buyer in one process ──────

async function runHoodi() {
  const sponsorKey = process.env.MORPH_HOODI_SPONSOR_KEY as `0x${string}` | undefined;
  const buyerKey = process.env.OWS_PRIVATE_KEY as `0x${string}` | undefined;
  if (!sponsorKey) throw new Error('MORPH_HOODI_SPONSOR_KEY required (Hoodi-funded sponsor)');
  if (!buyerKey) throw new Error('OWS_PRIVATE_KEY required (buyer with Hoodi USDC)');

  const chain = CHAINS['morph-hoodi-testnet'];
  const viemChain = defineChain({
    id: chain.chainId, name: chain.name,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  });
  const sponsorAccount = privateKeyToAccount(sponsorKey);
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  const sponsorClient = createWalletClient({ account: sponsorAccount, chain: viemChain, transport: http(chain.rpcUrl) });

  // STEP 1: facilitator on :4040
  const facilitatorPort = 4040;
  const facilitatorApp = express();
  facilitatorApp.use(express.json());
  const handler = createMorphHoodiFacilitator({
    usdcAddress: chain.tokens.USDC as `0x${string}`,
    publicClient: publicClient as never,
    sponsorClient: sponsorClient as never,
    sponsorAddress: sponsorAccount.address,
  });
  facilitatorApp.use((req, res, next) => Promise.resolve(handler(req as never, res as never)).catch(next));
  await new Promise<void>((r) => facilitatorApp.listen(facilitatorPort, () => {
    console.log(`[STEP 1] facilitator on http://localhost:${facilitatorPort}  sponsor=${sponsorAccount.address}`);
    r();
  }));

  // STEP 2: merchant paywall on :3030 — Hoodi route, scheme=eip3009
  const merchantPort = 3030;
  const merchantApp = express();
  const merchantPayTo = privateKeyToAccount(buyerKey).address; // demo: buyer pays themselves
  const paywallConfig = {
    routes: {
      'GET /api/weather': {
        price: '10000', // 0.01 USDC (6dp)
        description: 'Weather forecast — Hoodi via custom facilitator',
        morph: { payTo: merchantPayTo, network: chain.caip2, asset: chain.tokens.USDC, scheme: 'eip3009' as const },
      },
    },
  };
  merchantApp.use(createPaywall(paywallConfig) as any);
  merchantApp.get('/health', createHealthEndpoint(paywallConfig) as any);
  merchantApp.get('/api/weather', (req, res) => {
    const refKey = req.headers['x-payment-reference-key'] ?? 'unknown';
    res.json({ city: 'Hoodi', temp: 22, refKey });
  });
  await new Promise<void>((r) => merchantApp.listen(merchantPort, () => {
    console.log(`[STEP 2] merchant on http://localhost:${merchantPort}  payTo=${merchantPayTo}`);
    r();
  }));

  // STEP 3: buyer agent — pays via local facilitator on Hoodi
  const buyer = createPaymentClient({
    chains: ['morph-hoodi-testnet'],
    ows: { wallet: 'hoodi-buyer', privateKey: buyerKey },
    morph: { facilitatorUrl: `http://localhost:${facilitatorPort}/x402` },
    policy: { maxPerTransaction: 100_000n, maxPerDay: 10_000_000n },
  });
  const referenceKey = `HOODI-${Date.now().toString(36)}`;
  console.log(`[STEP 3] buyer ${privateKeyToAccount(buyerKey).address} paying with referenceKey=${referenceKey}`);
  const res = await buyer.fetchWithPayment(`http://localhost:${merchantPort}/api/weather`, undefined, { referenceKey });
  console.log(`[STEP 4] response status=${res.status} body=`, await res.json());

  const audit = buyer.getGuard()?.getAudit().queryByReferenceKey(referenceKey) ?? [];
  console.log(`[STEP 5] audit entries for ${referenceKey}: ${audit.length}`);
  process.exit(0);
}

// ─── Entry ─────────────────────────────────────────────────────────────────────

const mode = process.argv[2];
if (mode === 'server') runServer();
else if (mode === 'client') void runClient();
else if (mode === 'bridge') void runBridge();
else if (mode === 'hoodi') void runHoodi();
else console.log('Usage: tsx examples/morph-demo.ts <server|client|bridge|hoodi>');
