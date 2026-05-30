/**
 * Flare agentic-payments demo (v0.19).
 *
 * Reproduces both Flare flows end-to-end against any of the three networks:
 *   - x402 (MockUSDT0 + on-chain X402Facilitator)
 *   - gasless FXRP (GaslessPaymentForwarder + caller-run relayer)
 *
 * Modes:
 *   pnpm tsx examples/flare-payments-demo.ts deploy-x402     # deploy MockUSDT0 + X402Facilitator
 *   pnpm tsx examples/flare-payments-demo.ts deploy-gasless  # deploy GaslessPaymentForwarder
 *   pnpm tsx examples/flare-payments-demo.ts x402            # buyer + merchant in one process
 *   pnpm tsx examples/flare-payments-demo.ts gasless         # buyer + relayer (relayer must be running)
 *
 * Required env (deploy modes):
 *   FLARE_PRIVATE_KEY      — deployer; pays FLR for gas
 *   FLARE_NETWORK          — coston2-testnet|songbird-mainnet|flare-mainnet (default: coston2-testnet)
 *   X402_ARTIFACT_DIR      — directory containing MockUSDT0.json + X402Facilitator.json (Hardhat output)
 *   GASLESS_ARTIFACT_PATH  — path to GaslessPaymentForwarder.json
 *
 * Required env (run modes):
 *   FLARE_PRIVATE_KEY            — buyer account
 *   FLARE_X402_TOKEN_ADDRESS     — MockUSDT0 (from deploy step)
 *   FLARE_X402_FACILITATOR_ADDRESS
 *   FLARE_X402_PAY_TO            — merchant payee (often the same as FLARE_PRIVATE_KEY's address)
 *   FLARE_FORWARDER_ADDRESS      — for gasless mode
 *   FLARE_RELAYER_URL            — for gasless mode (default http://localhost:3000)
 *   FLARE_RECIPIENT_ADDRESS      — gasless recipient
 *
 * Compile contracts via Flare's Hardhat starter:
 *   https://github.com/flare-foundation/flare-hardhat-starter
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createFlareClient,
  createPaymentClient,
  createPaywall,
  deployFlareGaslessForwarder,
  deployFlareX402Contracts,
  FlareGaslessForwarderClient,
  type FlareNetwork,
} from '../src/index.js';

const NETWORK = (process.env.FLARE_NETWORK ?? 'coston2-testnet') as FlareNetwork;
const PK = process.env.FLARE_PRIVATE_KEY as `0x${string}` | undefined;
if (!PK) { console.error('FLARE_PRIVATE_KEY required'); process.exit(1); }

const flare = createFlareClient({ network: NETWORK });
const account = privateKeyToAccount(PK);
const chain = flare.publicClient.chain!;
const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0]) });
const walletClient = createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

function loadArtifact(p: string): { abi: Abi; bytecode: Hex } {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  // Hardhat output: { abi, bytecode } at top level.
  return { abi: j.abi as Abi, bytecode: j.bytecode as Hex };
}

async function deployX402() {
  const dir = process.env.X402_ARTIFACT_DIR;
  if (!dir) { console.error('X402_ARTIFACT_DIR required'); process.exit(1); }
  const out = await deployFlareX402Contracts({
    walletClient: walletClient as never,
    publicClient: publicClient as never,
    deployer: account.address,
    artifacts: {
      mockUsdt0: loadArtifact(join(dir, 'MockUSDT0.json')),
      x402Facilitator: loadArtifact(join(dir, 'X402Facilitator.json')),
    },
  });
  console.log('MockUSDT0:        ', out.mockUsdt0Address);
  console.log('X402Facilitator:  ', out.x402FacilitatorAddress);
  console.log('Add to env:');
  console.log(`  export FLARE_X402_TOKEN_ADDRESS=${out.mockUsdt0Address}`);
  console.log(`  export FLARE_X402_FACILITATOR_ADDRESS=${out.x402FacilitatorAddress}`);
}

async function deployGasless() {
  const p = process.env.GASLESS_ARTIFACT_PATH;
  if (!p) { console.error('GASLESS_ARTIFACT_PATH required'); process.exit(1); }
  const out = await deployFlareGaslessForwarder({
    walletClient: walletClient as never,
    publicClient: publicClient as never,
    artifact: loadArtifact(p),
  });
  console.log('GaslessPaymentForwarder:', out.forwarderAddress);
  console.log('Add to env:');
  console.log(`  export FLARE_FORWARDER_ADDRESS=${out.forwarderAddress}`);
}

async function runX402() {
  const TOKEN = process.env.FLARE_X402_TOKEN_ADDRESS as Address | undefined;
  const FACILITATOR = process.env.FLARE_X402_FACILITATOR_ADDRESS as Address | undefined;
  const PAY_TO = (process.env.FLARE_X402_PAY_TO ?? account.address) as Address;
  if (!TOKEN || !FACILITATOR) { console.error('FLARE_X402_TOKEN_ADDRESS + FLARE_X402_FACILITATOR_ADDRESS required'); process.exit(1); }

  // ── merchant: paywall middleware backed by X402Facilitator on-chain settle ──
  const PORT = 3402;
  const app = express();
  app.use(express.json());
  app.use(
    createPaywall(
      {
        routes: {
          'GET /api/premium': {
            price: '100000', // 0.1 USDT0 (6 decimals)
            description: 'Premium data — paid via Flare x402',
            flare: { payTo: PAY_TO, asset: TOKEN, facilitatorAddress: FACILITATOR, network: 'flare-coston2', chainId: chain.id },
          },
        },
      },
      { publicClient: publicClient as never, walletClient: walletClient as never },
    ),
  );
  app.get('/api/premium', (_req, res) => res.json({ ok: true, price: 0.0234, ts: Date.now() }));
  await new Promise<void>((resolve) => { app.listen(PORT, () => resolve()); });
  console.log(`[merchant] http://localhost:${PORT}`);

  // ── buyer: agent pays the paywall via fetchWithPayment ────────────────────
  const buyer = createPaymentClient({
    chains: [NETWORK === 'coston2-testnet' ? 'flare-coston2-testnet'
            : NETWORK === 'songbird-mainnet' ? 'flare-songbird-mainnet'
            : 'flare-mainnet'],
    ows: { wallet: 'flare-buyer-demo', privateKey: PK },
    flare: {
      network: NETWORK,
      x402: { tokenAddress: TOKEN, facilitatorAddress: FACILITATOR },
    },
  });
  const res = await buyer.fetchWithPayment(`http://localhost:${PORT}/api/premium`);
  console.log('[buyer] status:', res.status);
  console.log('[buyer] body:  ', await res.json());
  process.exit(0);
}

async function runGasless() {
  const FORWARDER = process.env.FLARE_FORWARDER_ADDRESS as Address | undefined;
  const RELAYER = process.env.FLARE_RELAYER_URL ?? 'http://localhost:3000';
  const RECIPIENT = process.env.FLARE_RECIPIENT_ADDRESS as Address | undefined;
  if (!FORWARDER) { console.error('FLARE_FORWARDER_ADDRESS required'); process.exit(1); }
  if (!RECIPIENT) { console.error('FLARE_RECIPIENT_ADDRESS required'); process.exit(1); }

  const client = new FlareGaslessForwarderClient({
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    forwarderAddress: FORWARDER,
    relayerUrl: RELAYER,
  });

  console.log('[buyer] checking status…');
  const status = await client.getStatus(account.address);
  console.log('  fxrp:     ', status.fxrpAddress);
  console.log('  balance:  ', status.balance.toString());
  console.log('  allowance:', status.allowance.toString());
  console.log('  nonce:    ', status.nonce.toString());

  if (status.needsApproval) {
    console.log('[buyer] approving forwarder for MaxUint256…');
    const tx = await client.approve();
    console.log('  approve tx:', tx);
  }

  // 0.1 FXRP, 6 decimals.
  const amount = 100_000n;
  console.log(`[buyer] sending ${amount} drops FXRP to ${RECIPIENT} via relayer ${RELAYER}…`);
  const result = await client.pay({ to: RECIPIENT, amount });
  console.log('[buyer] tx:        ', result.transactionHash);
  console.log('[buyer] gas (paid by sponsor):', result.gasUsed);
  process.exit(0);
}

const mode = process.argv[2];
const fn: Record<string, () => Promise<void>> = {
  'deploy-x402': deployX402,
  'deploy-gasless': deployGasless,
  'x402': runX402,
  'gasless': runGasless,
};
if (!mode || !fn[mode]) {
  console.error('Usage: flare-payments-demo.ts <deploy-x402|deploy-gasless|x402|gasless>');
  process.exit(1);
}
fn[mode]().catch((err) => {
  console.error(err);
  process.exit(1);
});
