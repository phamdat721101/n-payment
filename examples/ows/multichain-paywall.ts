#!/usr/bin/env tsx
/**
 * examples/ows/multichain-paywall.ts — v0.27 OWS multichain demo.
 *
 * Single parameterized example. CLI flags pick the chain; the same code path
 * runs for all 11 OWS chain families.
 *
 * Sample-mistake avoidance: NO per-chain demo files. Add a chain by adding a
 * row to the FAMILY_TABLE in src/ows/caip2.ts; this demo automatically
 * supports it.
 *
 * Usage:
 *   pnpm tsx examples/ows/multichain-paywall.ts --chain eip155:84532 --mock
 *   pnpm tsx examples/ows/multichain-paywall.ts --chain xrpl:testnet
 *   pnpm tsx examples/ows/multichain-paywall.ts --chain solana:devnet --wallet agent-treasury
 *
 * Flags:
 *   --chain <caip2>     CAIP-2 chain ID (required)
 *   --wallet <name>     OWS wallet name (default: "agent-treasury")
 *   --url <url>         Paywalled URL to fetch (default: built-in mock)
 *   --mock              Skip network — print derived address only
 *   --pk <hex>          Use legacy privateKey path (EVM only, for CI/serverless)
 */

import { OWSWallet, resolveFamily, resolveSpec, getDerivationPath } from '../../src/index.js';

interface Args {
  chain: string;
  wallet: string;
  url?: string;
  mock: boolean;
  pk?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { wallet: 'agent-treasury', mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--chain': args.chain = argv[++i]; break;
      case '--wallet': args.wallet = argv[++i]; break;
      case '--url': args.url = argv[++i]; break;
      case '--pk': args.pk = argv[++i]; break;
      case '--mock': args.mock = true; break;
      case '--help': case '-h':
        console.log(__filename.split('/').pop() + ' — see file header for usage');
        process.exit(0);
    }
  }
  if (!args.chain) {
    console.error('error: --chain <caip2> is required (e.g. eip155:84532, xrpl:testnet, solana:devnet)');
    process.exit(2);
  }
  return args as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const family = resolveFamily(args.chain);
  const spec = resolveSpec(args.chain);

  console.log('━'.repeat(60));
  console.log(`OWS multichain demo — v0.27`);
  console.log(`  chain:           ${args.chain}`);
  console.log(`  family:          ${family}`);
  console.log(`  curve:           ${spec.curve}`);
  console.log(`  derivation:      ${getDerivationPath(family, 0)}`);
  console.log(`  wallet:          ${args.wallet}`);
  console.log(`  legacy pk:       ${args.pk ? 'yes (EVM-only fallback)' : 'no (OWS-native)'}`);
  console.log('━'.repeat(60));

  const wallet = new OWSWallet({ wallet: args.wallet, privateKey: args.pk });

  // Step 1 — derive address for the chain.
  let address: string;
  try {
    address = await wallet.getAddress(args.chain);
    console.log(`✓ derived address: ${address}`);
  } catch (err) {
    console.error(`✗ getAddress failed: ${(err as Error).message}`);
    if (!args.pk) {
      console.error('  hint: run `ows wallet create --name ' + args.wallet + ' --chains ' + args.chain + '` first');
      console.error('  hint: or pass --pk <hex> for legacy EVM-only mode');
    }
    process.exit(1);
  }

  // Step 2 — sign a sample message (proves OWS-native or legacy path is wired).
  try {
    const sig = await wallet.signMessage(args.chain, 'n-payment-v0.27-demo');
    console.log(`✓ signMessage:      ${sig.slice(0, 32)}...`);
  } catch (err) {
    console.warn(`⚠ signMessage skipped: ${(err as Error).message}`);
  }

  // Step 3 — payrouter integration. Only EVM + Solana + XRPL + Cosmos have
  // payrouter rails wired in v0.27. Other 7 families ship wallet-only.
  if (args.mock) {
    console.log('— mock mode: skipping x402 fetchWithPayment —');
    return;
  }

  const RAILED_FAMILIES = new Set(['evm', 'solana', 'xrpl', 'cosmos']);
  if (!RAILED_FAMILIES.has(family)) {
    console.log('');
    console.log(`! family "${family}" is wallet-bound but has no payrouter rail in v0.27.`);
    console.log(`  Address derivation + signing work; full fetchWithPayment lands in v0.28.`);
    console.log(`  See docs/PRD-v027-ows-multichain-overhaul.md §3 (out of scope).`);
    return;
  }

  if (!args.url) {
    console.log('— no --url provided; skipping fetchWithPayment (use --mock to silence) —');
    return;
  }

  // Lazy import to avoid pulling the full client when this demo runs in --mock mode.
  const { createPaymentClient } = await import('../../src/index.js');
  const client = createPaymentClient({
    chains: [chainKeyForFamily(family)],
    ows: { wallet: args.wallet, privateKey: args.pk as `0x${string}` | undefined },
  });

  console.log(`→ GET ${args.url}`);
  const res = await client.fetchWithPayment(args.url);
  console.log(`✓ status: ${res.status}`);
  const body = await res.text();
  console.log(`✓ body (first 200 chars): ${body.slice(0, 200)}`);
}

/** Map an OWS family to a default n-payment chain key (for the createPaymentClient call). */
function chainKeyForFamily(family: string): string {
  switch (family) {
    case 'evm':    return 'base-sepolia';
    case 'solana': return 'solana-mainnet';
    case 'xrpl':   return 'xrpl-testnet';
    case 'cosmos': return 'initia-testnet';
    default: throw new Error(`no default chain key for family ${family}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
