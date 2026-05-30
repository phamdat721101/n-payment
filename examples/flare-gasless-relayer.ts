/**
 * Flare gasless FXRP relayer — standalone Express service (v0.19).
 *
 *   FLARE_RELAYER_PRIVATE_KEY=0x... \
 *   FLARE_FORWARDER_ADDRESS=0x...   \
 *   FLARE_NETWORK=coston2-testnet|songbird-mainnet|flare-mainnet \
 *   pnpm tsx examples/flare-gasless-relayer.ts
 *
 *   Endpoints (matches Flare's reference relayer):
 *     POST /execute       — submit a signed PaymentRequest, sponsor pays gas
 *     GET  /nonce/:addr   — convenience helper for the client
 *     GET  /healthz       — sponsor address + chain
 */
import express from 'express';
import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createFlareClient,
  createGaslessExecutor,
  FORWARDER_ABI,
  type FlarePaymentRequest,
} from '../src/index.js';
import type { FlareNetwork } from '../src/index.js';

const PORT = Number(process.env.PORT ?? 3000);
const PK = process.env.FLARE_RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
const FORWARDER = process.env.FLARE_FORWARDER_ADDRESS as `0x${string}` | undefined;
const NETWORK = (process.env.FLARE_NETWORK ?? 'coston2-testnet') as FlareNetwork;

if (!PK) { console.error('FLARE_RELAYER_PRIVATE_KEY required (sponsor account, must hold FLR for gas)'); process.exit(1); }
if (!FORWARDER) { console.error('FLARE_FORWARDER_ADDRESS required'); process.exit(1); }

// Reuse FlareClient's chain map by constructing it and pulling out chain + transport.
const flare = createFlareClient({ network: NETWORK });
const sponsor = privateKeyToAccount(PK);
// `flare.publicClient.chain` is the chain we registered in src/flare/client.ts.
const chain = flare.publicClient.chain!;
const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const sponsorClient = createWalletClient({ account: sponsor, chain, transport: http(chain.rpcUrls.default.http[0]) });

const execute = createGaslessExecutor({
  publicClient: publicClient as never,
  sponsorClient: sponsorClient as never,
  forwarderAddress: FORWARDER,
});

const app = express();
app.use(express.json());

app.get('/healthz', async (_req, res) => {
  const balance = await publicClient.getBalance({ address: sponsor.address });
  res.json({ ok: true, sponsor: sponsor.address, network: NETWORK, balanceWei: balance.toString() });
});

app.get('/nonce/:addr', async (req, res) => {
  try {
    const nonce = (await publicClient.readContract({
      address: FORWARDER,
      abi: FORWARDER_ABI,
      functionName: 'getNonce',
      args: [req.params.addr as `0x${string}`],
    })) as bigint;
    res.json({ nonce: nonce.toString() });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/execute', async (req, res) => {
  try {
    const result = await execute(req.body as FlarePaymentRequest);
    res.json(result);
  } catch (err) {
    const e = err as Error & { code?: string };
    res.status(400).json({ error: e.message, code: e.code ?? 'FLARE_GASLESS_RELAYER_ERROR' });
  }
});

app.listen(PORT, () => {
  console.log(`[flare-gasless-relayer] sponsor=${sponsor.address} network=${NETWORK} forwarder=${FORWARDER}`);
  console.log(`[flare-gasless-relayer] http://localhost:${PORT}  (POST /execute, GET /nonce/:addr, GET /healthz)`);
});
