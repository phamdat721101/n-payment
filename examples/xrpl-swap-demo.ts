/**
 * n-payment v0.14 — XRPL auto-swap + treasury demo.
 *
 * Subcommands:
 *   health                 — XrplClient.health() preflight (connection, trustline, AMM)
 *   quote <amountOutRlusd> — quote XRP→RLUSD via XRPL native AMM
 *   swap  <amountOutRlusd> — execute the swap on testnet
 *   pay   <url>            — fetchWithPayment() with autoSwap + treasury enabled
 *
 * Required env:
 *   XRPL_SEED          XRPL secret seed (sEd...) — fund via xrpl.org/resources/dev-tools
 *   XRPL_NETWORK       testnet | mainnet (default: testnet)
 */
import { createXrplClient, createPaymentClient } from '../src/index.js';

const NETWORK = (process.env.XRPL_NETWORK as 'testnet' | 'mainnet') ?? 'testnet';
const SEED = process.env.XRPL_SEED;

const dropsToXrp = (drops: bigint): string => {
  const xrp = drops / 1_000_000n;
  const frac = drops % 1_000_000n;
  return frac === 0n ? `${xrp}` : `${xrp}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
};

function requireSeed(): string {
  if (!SEED) {
    console.error('[demo] Set XRPL_SEED to a funded testnet seed. Get one at https://xrpl.org/resources/dev-tools/xrp-faucets');
    process.exit(1);
  }
  return SEED;
}

async function cmdHealth(): Promise<void> {
  const xrpl = createXrplClient({ seed: requireSeed(), network: NETWORK });
  const report = await xrpl.health();
  console.log(JSON.stringify(report, null, 2));
  await xrpl.disconnect();
}

async function cmdQuote(amountOut: string): Promise<void> {
  const xrpl = createXrplClient({ seed: requireSeed(), network: NETWORK });
  const quote = await xrpl.swap.quote({ from: 'XRP', to: 'RLUSD', amountOut });
  console.log({
    sourceAmountDrops: quote.sourceAmountDrops.toString(),
    sourceAmountXrp: dropsToXrp(quote.sourceAmountDrops),
    spotRateDropsPerUnit: quote.spotRateDropsPerUnit.toFixed(6),
    pathHops: quote.paths.length,
    validUntilIso: new Date(quote.validUntil).toISOString(),
  });
  await xrpl.disconnect();
}

async function cmdSwap(amountOut: string): Promise<void> {
  const xrpl = createXrplClient({ seed: requireSeed(), network: NETWORK });
  await xrpl.ensureTrustLine();
  const result = await xrpl.swap.swap({ from: 'XRP', to: 'RLUSD', amountOut, maxSlippageBps: 100 });
  console.log({
    txHash: result.hash,
    paidDrops: result.amountInDrops.toString(),
    receivedRlusd: result.amountOut,
    effectiveRate: result.effectiveRateDropsPerUnit.toFixed(6),
  });
  await xrpl.disconnect();
}

async function cmdPay(url: string): Promise<void> {
  const client = createPaymentClient({
    chains: [NETWORK === 'mainnet' ? 'xrpl-mainnet' : 'xrpl-testnet'],
    ows: { wallet: 'xrpl-demo-agent' },
    xrpl: {
      seed: requireSeed(),
      network: NETWORK,
      autoSwap: true,
      maxSlippageBps: 100,
      treasury: { autoYield: true, minIdleBalance: '5', autoCreate: true },
    },
  });
  const start = Date.now();
  const res = await client.fetchWithPayment(url);
  const elapsedMs = Date.now() - start;
  console.log({ status: res.status, elapsedMs, body: await res.text() });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'health': return cmdHealth();
    case 'quote':  return cmdQuote(args[0] ?? '5');
    case 'swap':   return cmdSwap(args[0] ?? '5');
    case 'pay':    {
      if (!args[0]) throw new Error('pay <url> required');
      return cmdPay(args[0]);
    }
    default:
      console.log('Usage: pnpm tsx examples/xrpl-swap-demo.ts <health|quote|swap|pay> [args...]');
      console.log('  health                  Connection + trustline + AMM diagnostic');
      console.log('  quote <amountOutRlusd>  Quote XRP→RLUSD swap');
      console.log('  swap  <amountOutRlusd>  Execute the swap');
      console.log('  pay   <url>             402-paywall pay with autoSwap + treasury');
      process.exit(0);
  }
}

main().catch((err) => {
  console.error('[demo] error:', err?.message ?? err);
  if (err?.code) console.error('[demo] code:', err.code, '\n[demo] hint:', err.hint ?? '(none)');
  process.exit(1);
});
