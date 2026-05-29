/**
 * Demo — Convert 0.0001 BTC → USDC on GOAT Network using n-payment v0.17.
 *
 * This script demonstrates the canonical UsdcAcquisitionRouter flow described
 * in the v0.17 changelog:
 *
 *   BTC (sourceIn) → [path] → USDC on GOAT (usdcOut)
 *
 * Three paths exist (see src/goat/paths.ts):
 *   • swap  — PegBTC on GOAT → USDC via OKU (Uniswap V3 fork). Cheapest, ~5s.
 *   • oft   — USDC on Base/etc → USDC on GOAT via LayerZero V2 OFT. ~90s.
 *   • pegin — BTC L1 → PegBTC on GOAT via the BitVM bridge. Hours, sovereign.
 *
 * For "full BTC L1 → USDC" you'd combine pegin + swap. Real BTC L1 needs an
 * external `BtcSigner` peer (the SDK never holds BTC keys). The EVM-only key
 * passed via PRIVATE_KEY only signs on the GOAT chain — it cannot sign BTC L1.
 *
 * Modes:
 *   default (mock):  pnpm tsx examples/btc-to-usdc-on-goat-demo.ts
 *   dry-run quote:   pnpm tsx examples/btc-to-usdc-on-goat-demo.ts --dry-run
 *   real testnet:    pnpm tsx examples/btc-to-usdc-on-goat-demo.ts --real
 *   amount override: pnpm tsx examples/btc-to-usdc-on-goat-demo.ts --btc 0.0005
 *
 * Mock mode emits deterministic synthetic receipts via MockSwapAdapter +
 * MockOftAdapter + MockBridgeAdapter — same code paths as production, just
 * the path adapters swapped for doubles. No RPC, faucet, or hosted-bridge
 * endpoints required.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SECURITY: this demo accepts a private key via PRIVATE_KEY env var or via
 * the inline DEMO_KEY constant below. Treat any key shared in plaintext as
 * compromised. Move funds and rotate after running.
 * ──────────────────────────────────────────────────────────────────────────
 */

import { privateKeyToAccount } from 'viem/accounts';
import {
  UsdcAcquisitionRouter,
  GoatAcquisitionPresets,
  PolicyEngine,
  AuditLog,
  SpendingGuard,
  OWSWallet,
  type AcquisitionPath,
} from '../src/index.js';

// ─── Args ────────────────────────────────────────────────────────────────────

interface CliArgs {
  amountBtc: number;
  realRun: boolean;
  dryRun: boolean;
  chain: 'goat-testnet' | 'goat-mainnet';
  btcUsd: number;
  paths: AcquisitionPath[];
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string, fallback?: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.split('=').slice(1).join('=');
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return fallback;
  };
  const flag = (name: string): boolean => argv.includes(`--${name}`);

  const amountBtc = Number(get('btc', '0.0001'));
  const realRun = flag('real');
  const dryRun = flag('dry-run');
  const chain = (get('chain', 'goat-testnet') as CliArgs['chain']);
  const btcUsd = Number(get('btc-usd', '70000'));
  const paths = (get('paths', 'swap')!.split(',') as AcquisitionPath[]);
  return { amountBtc, realRun, dryRun, chain, btcUsd, paths };
}

// ─── Pretty-print helpers ────────────────────────────────────────────────────

const fmt = {
  usdc: (wei: bigint) => `${(Number(wei) / 1e6).toFixed(6)} USDC`,
  pegbtc: (wei: bigint) => `${(Number(wei) / 1e8).toFixed(8)} PegBTC`,
  hr: () => console.log('─'.repeat(72)),
  section: (label: string) => {
    console.log();
    console.log(`══ ${label} ${'═'.repeat(Math.max(0, 68 - label.length))}`);
  },
};

// ─── Demo ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // The user-supplied EVM key. MUST be provided via PRIVATE_KEY env var.
  // We never inline keys in source — that's the rotation guarantee.
  const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!PRIVATE_KEY || !PRIVATE_KEY.startsWith('0x') || PRIVATE_KEY.length !== 66) {
    console.error('\nERROR: PRIVATE_KEY env var is required (0x-prefixed 64-hex EVM key).');
    console.error('Example:  PRIVATE_KEY=0x... npx tsx examples/btc-to-usdc-on-goat-demo.ts');
    process.exit(2);
  }
  const DEMO_KEY = PRIVATE_KEY;

  const account = privateKeyToAccount(DEMO_KEY);
  const targetUsdcWei = BigInt(Math.round(args.amountBtc * args.btcUsd * 1_000_000));

  fmt.section('🐐 0.0001 BTC → USDC on GOAT — n-payment v0.17 demo');
  console.log(`Chain          : ${args.chain}`);
  console.log(`Wallet (EVM)   : ${account.address}`);
  console.log(`Amount (BTC)   : ${args.amountBtc}`);
  console.log(`BTC/USD probe  : $${args.btcUsd.toLocaleString()}  (override --btc-usd)`);
  console.log(`Target USDC    : ${fmt.usdc(targetUsdcWei)}  (${targetUsdcWei} wei, 6-dec)`);
  console.log(`Allowed paths  : [${args.paths.join(', ')}]`);
  console.log(`Mode           : ${args.realRun ? 'REAL on-chain attempt' : 'MOCK (deterministic)'}${
    args.dryRun ? '  +  DRY-RUN (quote only, no execute)' : ''
  }`);

  if (!args.realRun) {
    fmt.section('Mock mode rationale');
    console.log(`• v0.17 ships OKU router/quoter as PLACEHOLDERS on goat-mainnet — production`);
    console.log(`  swap addresses land in v0.18.`);
    console.log(`• LayerZero OFT path throws GOAT_OFT_NOT_WIRED in v0.17 (slated for v0.18).`);
    console.log(`• BitVM peg-in needs an external BtcSigner peer (SDK never holds BTC keys);`);
    console.log(`  the EVM key here is secp256k1 for GOAT, not BTC L1.`);
    console.log(`• MockSwapAdapter emits deterministic synthetic receipts so the same code`);
    console.log(`  flow is exercised end-to-end without RPC, faucet, or hosted-bridge calls.`);
  }

  await runScenario(args, targetUsdcWei, DEMO_KEY);

  fmt.section('Done');
  console.log('Mock receipts are synthetic. Flip --real for an on-chain attempt; the SDK');
  console.log('will surface actionable error hints (GOAT_USDC_NOT_RESOLVED, GOAT_OFT_NOT_WIRED,');
  console.log('GOAT_BTC_SIGNER_MISSING, etc.) from the goatError factory.');
}

async function runScenario(
  args: CliArgs,
  targetUsdcWei: bigint,
  privateKey: `0x${string}`,
): Promise<void> {
  // SpendingGuard tracks acquisition-type entries in a rolling window.
  const guard = new SpendingGuard(new PolicyEngine([]), new AuditLog());

  // Build a wallet. Mock mode reads address only; real mode also signs.
  const wallet = args.realRun
    ? new OWSWallet({
        wallet: 'btc-to-usdc-demo',
        privateKey,
        autoFaucet: false,
      })
    : ({
        // Lightweight stub used by mock mode — returns the address derived from
        // the same key so logs match. Mock adapters never call signTransaction.
        getAddressAsync: async () => privateKeyToAccount(privateKey).address,
        getBalance: async () => 0n,
      } as unknown as OWSWallet);

  const router = new UsdcAcquisitionRouter({
    goatChain: args.chain,
    wallet,
    config: {
      ...GoatAcquisitionPresets.testnet(),
      allowedPaths: args.paths,
      // Tighten slippage to v0.18 production defaults; testnet preset is loose.
      maxSlippageBps: 100,
      maxFeeBps: 100,
    },
    mockMode: !args.realRun,
    partnerChains: ['base-mainnet'],
    guard,
  });

  // ── 1. Probe (estimate / dry-run) ────────────────────────────────────────
  fmt.section('1. Estimate (no on-chain write)');
  // For mock mode we have to pre-load a deterministic balance sheet so the
  // BalanceSheetStrategy has something to pick from. Real mode reads via
  // Multicall3 from the configured rpcUrl.
  if (!args.realRun) {
    (router as unknown as { balances: { read: () => Promise<unknown> } }).balances.read =
      async () => ({
        // 1.0 PegBTC on GOAT (8-dec) — way more than 0.0001 needs.
        pegbtcOnGoat: 100_000_000n,
        usdcOnGoat: 0n,
        usdcByChain: { 'base-mainnet': 100_000_000n }, // $100 fallback
        btcL1Sats: 1_000_000n, // 0.01 BTC on L1
      });
  }

  try {
    const decision = await router.estimate({ targetUsdcWei });
    if (decision) {
      console.log(`  path        : ${decision.path}`);
      console.log(`  usdcOut     : ${fmt.usdc(decision.quote.usdcOut)}`);
      console.log(`  sourceIn    : ${decision.quote.sourceIn} ${decision.quote.path === 'swap' ? `(${fmt.pegbtc(decision.quote.sourceIn)})` : 'wei'}`);
      console.log(`  sourceChain : ${decision.quote.sourceChain}`);
      console.log(`  feeBps      : ${decision.quote.feeBps}  (≈${(decision.quote.feeBps / 100).toFixed(2)}%)`);
      console.log(`  feeWei      : ${decision.quote.feeWei}`);
      console.log(`  etaSeconds  : ${decision.quote.etaSeconds}`);
      console.log(`  validUntil  : ${new Date(decision.quote.validUntil).toISOString()}`);
    } else {
      console.log('  no decision returned — likely targetUsdcWei is 0 after partial-fill math');
    }
  } catch (e) {
    const err = e as Error & { code?: string; hint?: string };
    console.log(`  estimate failed: ${err.code ?? 'UNKNOWN'} — ${err.message}`);
    if (err.hint) console.log(`  hint        : ${err.hint}`);
    return;
  }

  if (args.dryRun) {
    fmt.section('2. Dry-run only — exiting before execute');
    return;
  }

  // ── 2. Acquire (executes the chosen path) ────────────────────────────────
  fmt.section('2. Acquire (execute chosen path)');
  try {
    const r = await router.acquire({
      targetUsdcWei,
      idempotencyKey: `btc-usdc-demo-${args.amountBtc}-${Math.floor(Date.now() / 60_000)}`,
    });
    console.log(`  status      : ${r.status}`);
    console.log(`  acquired    : ${fmt.usdc(r.acquired)}  (${r.acquired} wei)`);
    console.log(`  correlation : ${r.correlationId}`);
    if (r.quote) {
      console.log(`  path used   : ${r.quote.path}  (sourceChain=${r.quote.sourceChain})`);
    }
    if (r.receipt) {
      console.log(`  receipt:`);
      console.log(`    srcTxHash  : ${r.receipt.srcTxHash}`);
      console.log(`    dstTxHash  : ${r.receipt.dstTxHash ?? '— (pending mint)'}`);
      console.log(`    feePaid    : ${r.receipt.feePaid}`);
      console.log(`    durationMs : ${r.receipt.durationMs}`);
    }
  } catch (e) {
    const err = e as Error & { code?: string; hint?: string };
    console.log(`  acquire failed: ${err.code ?? 'UNKNOWN'} — ${err.message}`);
    if (err.hint) console.log(`  hint        : ${err.hint}`);
  }

  // ── 3. Audit summary ─────────────────────────────────────────────────────
  fmt.section('3. Audit log (acquisition-type entries)');
  const entries = guard.getAudit().query({ type: 'acquisition' });
  if (!entries.length) {
    console.log('  (no acquisition entries — likely dry-run or no-op)');
  } else {
    for (const e of entries) {
      // AuditEntry has typed optional acquisition fields when type === 'acquisition'.
      console.log(`  • ${new Date(e.timestamp).toISOString()}  amount=${e.amount}  ` +
        `path=${e.acquisitionPath ?? '-'}  ` +
        `src=${e.acquisitionSrcChain ?? '-'}  ` +
        `tx=${e.acquisitionTxHash ?? '-'}`);
    }
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
