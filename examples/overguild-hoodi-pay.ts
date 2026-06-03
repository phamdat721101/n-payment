/**
 * Overguild signal API — paid via Morph Hoodi x402 (eip3009 sponsored).
 *
 *   pnpm tsx examples/overguild-hoodi-pay.ts
 *
 * Reads BUYER_KEY (defaults to provided demo key on Hoodi). Spawns the local
 * Morph Hoodi facilitator on :4040 with the SAME wallet acting as the sponsor
 * (buyer pays its own gas — fine since only ETH on Hoodi is needed). Calls
 * https://ai.overguild.com/agent-api/api/v2/agent/decisions?limit=5 via
 * n-payment's PaymentClient, which auto-handles 402 → sign EIP-3009 →
 * facilitator settle on-chain → retry-with-proof.
 */
import express from 'express';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, createMorphHoodiFacilitator, createPaymentClient } from '../src/index.js';

const TARGET_URL = 'https://ai.overguild.com/agent-api/api/v2/agent/decisions?limit=5';
const FAC_PORT = Number(process.env.FAC_PORT ?? 4040);

const KEY = (process.env.BUYER_KEY ??
  '0xc95478ce49edd634d31849553d92ef325cd3aabd1ccbc94c4d2273575a378c54') as `0x${string}`;

async function main() {
  const account = privateKeyToAccount(KEY);
  console.log('[runner] wallet =', account.address);

  const chain = CHAINS['morph-hoodi-testnet'];
  const viemChain = defineChain({
    id: chain.chainId, name: chain.name,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
  const sponsorClient = createWalletClient({ account, chain: viemChain, transport: http(chain.rpcUrl) });

  // ─── 1. Spawn local Morph Hoodi facilitator on :4040 ──────────────────────
  const app = express();
  app.use(express.json());
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, sponsor: account.address, chain: chain.name });
  });
  const handler = createMorphHoodiFacilitator({
    usdcAddress: chain.tokens.USDC as `0x${string}`,
    publicClient: publicClient as never,
    sponsorClient: sponsorClient as never,
    sponsorAddress: account.address,
    // Hoodi USDC reports name() = 'USDC' (NOT Circle's mainnet 'USD Coin').
    tokenName: 'USDC',
    tokenVersion: '2',
  });
  app.use((req, res, next) =>
    Promise.resolve(handler(req as never, res as never)).catch(next),
  );
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(FAC_PORT, () => resolve(s));
  });
  console.log(`[runner] facilitator on http://localhost:${FAC_PORT}/x402`);

  try {
    // ─── 2. Build the buyer client and fetch with payment ───────────────────
    const client = createPaymentClient({
      chains: ['morph-hoodi-testnet'],
      ows: { wallet: 'overguild-hoodi', privateKey: KEY },
      morph: {
        facilitatorUrl: `http://localhost:${FAC_PORT}/x402`,
        // Match the on-chain Hoodi USDC EIP-712 domain.
        tokenName: 'USDC',
        tokenVersion: '2',
      },
      policy: { maxPerTransaction: 100_000n, maxPerDay: 10_000_000n },
    });

    console.log(`[runner] GET ${TARGET_URL}`);
    const res = await client.fetchWithPayment(TARGET_URL);
    const body = await res.text();
    console.log(`[runner] HTTP ${res.status}`);

    // Print the raw body and a structured summary.
    console.log('\n──────── overguild response ────────');
    console.log(body.length > 8000 ? body.slice(0, 8000) + '\n…(truncated)' : body);

    let parsed: unknown = null;
    try { parsed = JSON.parse(body); } catch { /* not JSON */ }
    if (parsed && typeof parsed === 'object') {
      const decisions = (parsed as { decisions?: unknown[]; data?: unknown[] }).decisions
        ?? (parsed as { data?: unknown[] }).data ?? [];
      const arr = Array.isArray(decisions) ? decisions : [];
      console.log(`\n──────── parsed ${arr.length} decisions ────────`);
      for (const d of arr) {
        const o = d as Record<string, unknown>;
        const verdict = o.verdict ?? o.signal ?? o.action ?? o.recommendation ?? '?';
        const ticker = o.ticker ?? o.symbol ?? o.token ?? o.asset ?? '?';
        const conf = o.confidence ?? o.score ?? o.weight ?? null;
        const note = o.reason ?? o.summary ?? o.rationale ?? o.thesis ?? '';
        console.log(`  - ${String(ticker).padEnd(10)} ${String(verdict).padEnd(8)} ${conf ?? ''} :: ${String(note).slice(0, 200)}`);
      }
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().catch((e) => { console.error('[runner] FAILED:', e); process.exit(1); });
