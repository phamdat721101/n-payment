/**
 * Off-ramp loop demo — agent earns MGUSD, cashes out at MoneyGram retail.
 *
 * v0.21 SCF #44 ecosystem-impact narrative artifact. Demonstrates closing the loop:
 *   AI agent earns MGUSD via paid services → agent's self-custody wallet → SEP-24
 *   anchor withdraw → physical cash at any of MoneyGram's 500K retail locations.
 *
 * Run:
 *   pnpm tsx examples/stellar-mgusd-offramp-demo.ts
 *
 * Env (live mode):
 *   STELLAR_BUYER_SECRET=S...    (the agent's Stellar secret key for SEP-10 auth)
 *   STELLAR_BUYER_AMOUNT=10.00   (how much MGUSD to off-ramp; default 10)
 *   STELLAR_BUYER_FIAT=USD       (target fiat; default USD)
 *   STELLAR_BUYER_COUNTRY=US     (ISO country; default US)
 *
 * Without env, prints the anchor list discovery only (no SEP-10 sign).
 *
 * Optional KYA preflight (commented at end of file): if a paywall declares
 * `kya_required:true`, the buyer fetches a credential via StellarKyaCredentialFetcher
 * and attaches `x-kya-credential` to the retry. The same primitive is exposed via
 * `attachKyaIfRequired` in the StellarX402Adapter / StellarMppAdapter constructors.
 */
import {
  StellarAnchorClient,
  KeypairStellarSigner,
  StellarKyaCredentialFetcher,
  attachKyaIfRequired,
  type StellarSigner,
} from '../src/index.js';

const AMOUNT = process.env.STELLAR_BUYER_AMOUNT ?? '10.00';
const FIAT = process.env.STELLAR_BUYER_FIAT ?? 'USD';
const COUNTRY = process.env.STELLAR_BUYER_COUNTRY ?? 'US';
const SECRET = process.env.STELLAR_BUYER_SECRET;

async function main(): Promise<void> {
  const client = new StellarAnchorClient();

  // 1. Discovery — list anchors capable of off-ramping MGUSD → fiat in this country.
  console.log(`\n[1/3] Looking up anchors for MGUSD → ${FIAT} in ${COUNTRY}…`);
  let anchors;
  try {
    anchors = await client.findAnchor('MGUSD', FIAT, COUNTRY);
  } catch (err) {
    console.error(`  discovery failed: ${(err as Error).message}`);
    process.exit(1);
  }
  if (anchors.length === 0) {
    console.log(`  no anchors found. Check https://stellar.expert/explorer/directory.`);
    return;
  }
  for (const a of anchors) {
    console.log(`  - ${a.name} (${a.homeDomain}); transferServer: ${a.serviceUrls.transferServer ?? '<not hydrated>'}`);
  }

  if (!SECRET) {
    console.log('\n[skip] STELLAR_BUYER_SECRET not set — discovery only. Set the env to initiate withdraw.');
    return;
  }

  // 2. Initiate SEP-24 withdraw via the first matching anchor (MoneyGram-first by registry order).
  console.log(`\n[2/3] Initiating ${AMOUNT} MGUSD withdraw via ${anchors[0].name}…`);
  const signer: StellarSigner = await KeypairStellarSigner.fromSecret(SECRET);
  const handle = await client.cashOut(AMOUNT, 'MGUSD', FIAT, signer, COUNTRY);
  console.log(`  transaction id : ${handle.transactionId}`);
  console.log(`  more_info_url  : ${handle.moreInfoUrl}`);

  // 3. Status polling — open the more_info_url in a browser/webview to complete KYC + payout.
  console.log(`\n[3/3] Polling status until terminal…`);
  let status = await handle.status();
  console.log(`  status: ${status.status} (updated ${status.updatedAt})`);
  const TERMINAL = new Set(['completed', 'error', 'expired', 'refunded']);
  let tries = 0;
  while (!TERMINAL.has(status.status) && tries < 60) {
    await new Promise((r) => setTimeout(r, 5000));
    status = await handle.status();
    console.log(`  status: ${status.status} (updated ${status.updatedAt})`);
    tries += 1;
  }
  console.log(`\nFinal: ${status.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/* ─── Optional: KYA preflight pattern (paste into your buyer flow) ──────────
 *
 *   import { StellarKyaCredentialFetcher, attachKyaIfRequired } from 'n-payment';
 *
 *   const kyaFetcher = new StellarKyaCredentialFetcher(
 *     process.env.KYA_ORACLE_URL!,
 *     process.env.KYA_ORACLE_API_KEY,
 *   );
 *
 *   const headers = new Headers(initHeaders);
 *   await attachKyaIfRequired(
 *     headers,
 *     parsedChallenge.extra,    // x402: extra; mpp: { kya_required }
 *     kyaFetcher,
 *     buyerAddress,
 *   );
 *   const res = await fetch(url, { headers });
 *
 * For Stellar x402 / MPP adapters, simply pass `kyaFetcher` as the last constructor
 * arg and attach happens automatically on each 402 retry.
 * ─────────────────────────────────────────────────────────────────────────── */
// Suppress "unused import" warnings when example runs without KYA path.
void StellarKyaCredentialFetcher;
void attachKyaIfRequired;
