/**
 * v0.22 — RLUSD multichain demo.
 *
 * Demonstrates a buyer agent that holds RLUSD on Optimism and pays a paid-MCP
 * on Base in a single fetchWithPayment(url) call. The SDK auto-bridges via
 * Wormhole NTT and settles the 402 with the on-chain `exact` scheme proof.
 *
 * Prerequisites:
 *   OPTIMISM_PRIVATE_KEY, BASE_PRIVATE_KEY  — signers (or use a single key for both)
 *   OPTIMISM_RPC, BASE_RPC                  — RPC endpoints (defaults work for read)
 *   MERCHANT_URL                            — a paid endpoint accepting RLUSD on Base
 *
 * Optional peer-deps for production runs:
 *   pnpm add @wormhole-foundation/sdk @wormhole-foundation/sdk-evm @wormhole-foundation/sdk-evm-ntt ethers
 *
 * Usage:
 *   pnpm tsx examples/rlusd-multichain-demo.ts
 */
import 'dotenv/config';
import { createPaymentClient, RLUSD_NTT_DEPLOYMENTS } from '../src/index.js';

async function main() {
  const t0 = Date.now();
  console.log('🚀 n-payment v0.22 RLUSD multichain demo');
  console.log('   chains: optimism-mainnet, base-mainnet (NTT registry has 5 chains total)');
  console.log('   registry:', Object.keys(RLUSD_NTT_DEPLOYMENTS).join(', '));

  const url = process.env.MERCHANT_URL ?? 'https://demo-paid-mcp.n-payment.dev/llm';
  const opPk = process.env.OPTIMISM_PRIVATE_KEY;
  const basePk = process.env.BASE_PRIVATE_KEY ?? opPk;

  if (!opPk || !basePk) {
    console.warn(
      '\n[demo] OPTIMISM_PRIVATE_KEY / BASE_PRIVATE_KEY not set — running config-only sanity check.\n' +
        'Set them + install peer deps for a full mainnet bridge run.\n',
    );
  }

  // Load ethers v6 dynamically — peer dep, present only when running for real.
  let optimismWallet: unknown;
  let baseWallet: unknown;
  if (opPk) {
    try {
      const { ethers } = (await import('ethers' as string)) as { ethers: typeof import('ethers') };
      optimismWallet = new ethers.Wallet(
        opPk,
        new ethers.JsonRpcProvider(process.env.OPTIMISM_RPC ?? 'https://mainnet.optimism.io'),
      );
      baseWallet = new ethers.Wallet(
        basePk!,
        new ethers.JsonRpcProvider(process.env.BASE_RPC ?? 'https://mainnet.base.org'),
      );
    } catch (err) {
      console.warn('[demo] ethers not installed; skipping signer init.', (err as Error).message);
    }
  }

  const client = createPaymentClient({
    chains: ['optimism-mainnet', 'base-mainnet', 'ethereum-mainnet', 'ink-mainnet', 'unichain-mainnet'],
    ows: { wallet: 'demo-agent', privateKey: (basePk ?? '0x' + '0'.repeat(64)) as `0x${string}` },
    wormhole: optimismWallet
      ? {
          signers: {
            Optimism: optimismWallet as never,
            Base: baseWallet as never,
          },
          maxPerTransfer: 100n * 10n ** 18n,
          maxPerDay: 1000n * 10n ** 18n,
        }
      : undefined,
  });

  console.log(`\n→ fetchWithPayment(${url})`);
  if (!opPk) {
    console.log('   (config-only mode — would have routed via PayRouter v3 corridor)');
    console.log(`✅ done in ${Date.now() - t0}ms`);
    return;
  }

  const res = await client.fetchWithPayment(url, {
    headers: { 'x-trace-id': 'rlusd-demo-' + Date.now() },
  });
  console.log(`\n← ${res.status} ${res.statusText}`);
  console.log('Response body:', await res.text());
  console.log(`\n✅ done in ${Date.now() - t0}ms`);
}

main().catch((err) => {
  console.error('❌ demo failed:', err);
  process.exit(1);
});
