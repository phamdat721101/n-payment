/**
 * v0.22 — Bridge-only smoke test (no x402 hop).
 *
 * Performs a single Wormhole NTT bridge from one EVM chain to another, returning
 * the receipt. Used as the manual mainnet smoke gate before `npm publish`.
 *
 * Usage:
 *   OPTIMISM_PRIVATE_KEY=0x... \
 *   OPTIMISM_RPC=https://mainnet.optimism.io \
 *   RLUSD_RECIPIENT=0x... \
 *   pnpm tsx examples/rlusd-ntt-bridge-only.ts --from optimism --to base --amount 0.10
 *
 * Peer deps required for real runs:
 *   pnpm add @wormhole-foundation/sdk @wormhole-foundation/sdk-evm @wormhole-foundation/sdk-evm-ntt ethers
 */
import 'dotenv/config';
import { WormholeNttClient, type WormholeChainName } from '../src/index.js';

interface Args {
  from: WormholeChainName;
  to: WormholeChainName;
  amount: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string, fallback?: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : fallback;
  };
  const cap = (s: string) => (s[0]?.toUpperCase() + s.slice(1).toLowerCase()) as WormholeChainName;
  return {
    from: cap(get('--from', 'Optimism')!),
    to: cap(get('--to', 'Base')!),
    amount: get('--amount', '0.10')!,
  };
}

async function main() {
  const { from, to, amount } = parseArgs();
  const pk = process.env[`${from.toUpperCase()}_PRIVATE_KEY`] ?? process.env.OPTIMISM_PRIVATE_KEY;
  const rpc = process.env[`${from.toUpperCase()}_RPC`];
  const recipient = process.env.RLUSD_RECIPIENT as `0x${string}` | undefined;

  console.log(`🌉 Wormhole NTT bridge ${from} → ${to}, ${amount} RLUSD`);
  if (!pk || !recipient) {
    console.warn('⚠️  Missing env (PRIVATE_KEY / RLUSD_RECIPIENT) — config-only mode');
    return;
  }

  const { ethers } = (await import('ethers' as string)) as { ethers: typeof import('ethers') };
  const wallet = new ethers.Wallet(pk, new ethers.JsonRpcProvider(rpc));

  const client = new WormholeNttClient({
    network: 'Mainnet',
    signers: { [from]: wallet as never } as never,
  });

  const amountUba = BigInt(Math.floor(parseFloat(amount) * 1e18));
  const t0 = Date.now();
  const receipt = await client.transfer({ from, to, amount: amountUba, recipient });
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`⏱️  total: ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('❌ bridge failed:', err);
  process.exit(1);
});
