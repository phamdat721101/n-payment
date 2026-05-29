/**
 * Morph Hoodi facilitator runner — boots the custom facilitator on :4040.
 *
 *   MORPH_HOODI_SPONSOR_KEY=0x… pnpm tsx examples/morph-hoodi-facilitator.ts
 *
 * Optional:
 *   MORPH_ACCESS_KEY / MORPH_SECRET_KEY  — turn on HMAC enforcement
 *   PORT                                  — override port (default 4040)
 *
 * The facilitator pays Hoodi gas on behalf of buyers via EIP-3009
 * `transferWithAuthorization` so agents can transact with **zero ETH**.
 */
import express from 'express';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, createMorphHoodiFacilitator } from '../src/index.js';

const PORT = Number(process.env.PORT ?? 4040);
const SPONSOR_KEY = process.env.MORPH_HOODI_SPONSOR_KEY as `0x${string}` | undefined;

if (!SPONSOR_KEY) {
  console.error('[facilitator] MORPH_HOODI_SPONSOR_KEY is required (Hoodi-funded sponsor account)');
  process.exit(1);
}

const chain = CHAINS['morph-hoodi-testnet'];
const viemChain = defineChain({
  id: chain.chainId, name: chain.name,
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [chain.rpcUrl] } },
});

const sponsorAccount = privateKeyToAccount(SPONSOR_KEY);
const publicClient = createPublicClient({ chain: viemChain, transport: http(chain.rpcUrl) });
const sponsorClient = createWalletClient({ account: sponsorAccount, chain: viemChain, transport: http(chain.rpcUrl) });

const handler = createMorphHoodiFacilitator({
  usdcAddress: chain.tokens.USDC as `0x${string}`,
  publicClient: publicClient as never,
  sponsorClient: sponsorClient as never,
  sponsorAddress: sponsorAccount.address,
  accessKey: process.env.MORPH_ACCESS_KEY,
  secretKey: process.env.MORPH_SECRET_KEY,
});

const app = express();
app.use(express.json());
app.get('/healthz', (_, res) => res.json({ ok: true, sponsor: sponsorAccount.address, chain: chain.name }));
app.use((req, res, next) => Promise.resolve(handler(req as never, res as never)).catch(next));

app.listen(PORT, () => {
  console.log(`[facilitator] Morph Hoodi facilitator on http://localhost:${PORT}`);
  console.log(`[facilitator]   sponsor: ${sponsorAccount.address}`);
  console.log(`[facilitator]   USDC:    ${chain.tokens.USDC}`);
  console.log(`[facilitator]   HMAC:    ${process.env.MORPH_ACCESS_KEY ? 'enforced' : 'permissive (set MORPH_ACCESS_KEY+MORPH_SECRET_KEY to enable)'}`);
  console.log(`[facilitator] endpoints: GET /x402/v2/supported  POST /x402/v2/verify  POST /x402/v2/settle`);
});
