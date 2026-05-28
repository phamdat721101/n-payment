/**
 * v0.17 — GOAT USDC Acquisition Router quickstart.
 *
 * Runs a deterministic end-to-end demo against goat-testnet using mock path
 * adapters — no real RPC / faucet / bridge endpoints required. The same code
 * runs in production when you swap MockMode off and supply real config.
 *
 * Usage:
 *   pnpm tsx examples/goat-testnet-quickstart.ts                  # default: auto + dry-run + acquire
 *   pnpm tsx examples/goat-testnet-quickstart.ts --scenario swap
 *   pnpm tsx examples/goat-testnet-quickstart.ts --scenario oft
 *   pnpm tsx examples/goat-testnet-quickstart.ts --scenario pegin
 *   pnpm tsx examples/goat-testnet-quickstart.ts --scenario all
 */

import {
  UsdcAcquisitionRouter,
  GoatAcquisitionPresets,
  PolicyEngine,
  AuditLog,
  SpendingGuard,
} from '../src/index.js';

const fakeWallet = {
  // Mock OWSWallet for the demo — the real PaymentClient wires this for you.
  getAddressAsync: async () => '0x000000000000000000000000000000000000bEEF',
  getBalance: async () => 0n,
} as any;

async function runScenario(label: string, allowedPaths: ('swap' | 'oft' | 'pegin')[], balances: any) {
  console.log(`\n── ${label} ────────────────────────────────────────────`);
  const guard = new SpendingGuard(new PolicyEngine([]), new AuditLog());
  const router = new UsdcAcquisitionRouter({
    goatChain: 'goat-testnet',
    wallet: fakeWallet,
    config: { ...GoatAcquisitionPresets.testnet(), allowedPaths },
    mockMode: true,
    partnerChains: ['base-mainnet'],
    guard,
  });

  // Stub the balance reader for a deterministic demo without hitting an RPC.
  (router as any).balances.read = async () => balances;

  // 1) Dry-run probe — quote without executing.
  const decision = await router.estimate({ targetUsdcWei: 1_000_000n }); // $1
  console.log('  estimate    →', decision ? `${decision.path} (eta ${decision.quote.etaSeconds}s, fee ${decision.quote.feeBps}bps)` : 'none');

  // 2) Real acquire — mutex + idempotency-keyed.
  try {
    const r = await router.acquire({
      targetUsdcWei: 1_000_000n,
      idempotencyKey: `${label}:${Math.floor(Date.now() / 60_000)}`,
    });
    console.log('  acquire     →', r.status, `path=${r.quote?.path}`, `acquired=${r.acquired}`);
    if (r.receipt) console.log('  receipt     →', `src=${r.receipt.srcTxHash}  dst=${r.receipt.dstTxHash}  ${r.receipt.durationMs}ms`);
  } catch (e: any) {
    console.log('  acquire     → ERROR', e.code, '—', e.hint);
  }

  // 3) Audit summary.
  const audit = guard.getAudit().query({ type: 'acquisition' });
  console.log(`  audit       → ${audit.length} acquisition entries`);
}

(async () => {
  const arg = process.argv.find((a) => a.startsWith('--scenario='))?.split('=')[1] ?? process.argv[3] ?? 'all';

  const scenarios: Record<string, { label: string; allowedPaths: ('swap' | 'oft' | 'pegin')[]; balances: any }> = {
    swap:  { label: 'Swap (PegBTC → USDC on GOAT)', allowedPaths: ['swap'],  balances: { pegbtcOnGoat: 1_000_000_000n, usdcOnGoat: 0n, usdcByChain: {} } },
    oft:   { label: 'OFT (Base → GOAT)',             allowedPaths: ['oft'],   balances: { pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: { 'base-mainnet': 100_000_000n } } },
    pegin: { label: 'BitVM Peg-In (BTC L1 → PegBTC)', allowedPaths: ['pegin'], balances: { pegbtcOnGoat: 0n, usdcOnGoat: 0n, usdcByChain: {}, btcL1Sats: 1_000_000n } },
    auto:  { label: 'Auto (balance-sheet picks)',    allowedPaths: ['swap', 'oft', 'pegin'], balances: { pegbtcOnGoat: 0n, usdcOnGoat: 600_000n, usdcByChain: { 'base-mainnet': 100_000_000n } } },
  };

  console.log('🐐 n-payment v0.17 — GOAT USDC Acquisition Router (testnet mock)');
  if (arg === 'all') {
    for (const k of Object.keys(scenarios)) await runScenario(scenarios[k].label, scenarios[k].allowedPaths, scenarios[k].balances);
  } else if (scenarios[arg]) {
    await runScenario(scenarios[arg].label, scenarios[arg].allowedPaths, scenarios[arg].balances);
  } else {
    console.error(`Unknown scenario: ${arg}. Try one of: ${Object.keys(scenarios).join(', ')}, all`);
    process.exit(1);
  }
})();
