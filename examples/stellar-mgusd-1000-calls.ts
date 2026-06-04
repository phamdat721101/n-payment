/**
 * 1000 paid AI calls in MGUSD, settled in a single Stellar transaction.
 *
 * v0.21 SCF #44 hero benchmark. Demonstrates n-payment's Stellar Session payment-channel
 * adapter with asset-aware preimages binding each commitment to MGUSD.
 *
 * Two execution modes:
 *   - LIVE: when STELLAR_MGUSD_CHANNEL + STELLAR_COMMITMENT_SECRET +
 *           STELLAR_COMMITMENT_PUBKEY + STELLAR_CLOSE_SIGNER_SECRET are set,
 *           runs against a deployed Soroban one-way-channel contract on testnet
 *           and emits a real settle_tx_hash.
 *   - MOCK: missing env vars — runs the off-chain sign + verify loop only and
 *           emits a synthetic tx hash. Proof of asset-aware preimage code path.
 *
 * Run:
 *   pnpm tsx examples/stellar-mgusd-1000-calls.ts
 *
 * Output: a single JSON line on stdout suitable for n-payment.dev/dashboard ingestion.
 */
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import {
  StellarSessionClient,
  StellarSessionServer,
  parseStellarAsset,
  formatStellarAsset,
  KeypairStellarSigner,
  type StellarSigner,
} from '../src/index.js';

const N_CALLS = 1000;
const PER_CALL_DISPLAY = '0.001';
const ASSET = 'MGUSD' as const;

async function main(): Promise<void> {
  const channel =
    process.env.STELLAR_MGUSD_CHANNEL ?? `C${'A'.repeat(55)}`; // mock channel id when not set
  const commitmentSecretHex =
    process.env.STELLAR_COMMITMENT_SECRET ?? Buffer.from(randomBytes(32)).toString('hex');
  const commitmentPubkeyHex = process.env.STELLAR_COMMITMENT_PUBKEY ?? (await derivePubkeyHex(commitmentSecretHex));
  const closeSignerSecret = process.env.STELLAR_CLOSE_SIGNER_SECRET;

  const isLive = Boolean(
    process.env.STELLAR_MGUSD_CHANNEL &&
      process.env.STELLAR_COMMITMENT_SECRET &&
      process.env.STELLAR_COMMITMENT_PUBKEY &&
      closeSignerSecret,
  );

  const closeSigner: StellarSigner = closeSignerSecret
    ? await KeypairStellarSigner.fromSecret(closeSignerSecret)
    : stubCloseSigner();

  const client = new StellarSessionClient({
    channel,
    asset: ASSET,
    commitmentSecretHex,
    chainKey: 'stellar-testnet',
  });
  const server = new StellarSessionServer({
    channel,
    asset: ASSET,
    commitmentPubkeyHex,
    chainKey: 'stellar-testnet',
    closeSigner,
  });

  const perCall = parseStellarAsset(PER_CALL_DISPLAY, ASSET);
  const t0 = performance.now();
  let validCount = 0;

  for (let i = 0; i < N_CALLS; i++) {
    const v = await client.signCommitment(perCall);
    const verdict = await server.verifyVoucher(v.credential, perCall);
    if (verdict.valid) validCount += 1;
  }
  const tSign = performance.now() - t0;

  let settleTxHash: string;
  let tClose: number;
  if (isLive) {
    const tCloseStart = performance.now();
    const close = await server.closeChannel();
    tClose = performance.now() - tCloseStart;
    settleTxHash = close.txHash;
  } else {
    settleTxHash = `mock:${Buffer.from(randomBytes(16)).toString('hex')}`;
    tClose = 0;
  }

  const cumulativeBase = perCall * BigInt(validCount);
  const cumulativeDisplay = formatStellarAsset(cumulativeBase, ASSET, 4);

  // Single JSON line for dashboard ingestion.
  console.log(
    JSON.stringify({
      mode: isLive ? 'live' : 'mock',
      asset: ASSET,
      n_calls: N_CALLS,
      valid_vouchers: validCount,
      cumulative_amount_base: cumulativeBase.toString(),
      cumulative_amount_display: cumulativeDisplay,
      sign_phase_ms: Math.round(tSign),
      close_phase_ms: Math.round(tClose),
      per_call_cost_note: '~$0.000001 off-chain ed25519 + amortized close fee (single Stellar tx)',
      settle_tx_hash: settleTxHash,
      settlement_chain: 'stellar-testnet',
    }),
  );
}

function stubCloseSigner(): StellarSigner {
  return {
    address: 'G' + 'A'.repeat(55),
    signAuthEntry: async () => 'stub',
    signTransaction: async (xdr) => `signed:${xdr}`,
    signRaw: async (b) => b,
  };
}

async function derivePubkeyHex(secretHex: string): Promise<string> {
  const sdk = await import('@stellar/stellar-sdk');
  const seed = Buffer.from(secretHex, 'hex');
  const kp = sdk.Keypair.fromRawEd25519Seed(seed);
  const raw = sdk.StrKey.decodeEd25519PublicKey(kp.publicKey());
  return Buffer.from(raw).toString('hex');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
