/**
 * SpaceRouter (SpaceCoin) demo — agentic-bandwidth + paywall settlement.
 *
 * Three commands:
 *   pnpm tsx examples/spacerouter-demo.ts proxy        — fetch IP via residential proxy (region: KR)
 *   pnpm tsx examples/spacerouter-demo.ts smart-fallback — fetch a CF-blocked URL, auto-route via proxy
 *   pnpm tsx examples/spacerouter-demo.ts combined     — same client routes via SpaceRouter AND pays a Morph 402 endpoint
 *
 * Required env:
 *   SR_PRIVATE_KEY           — Creditcoin wallet (holds SPACE for escrow + CTC for gas)
 *   SR_GATEWAY_URL           — default: https://gateway.spacerouter.org
 *   SR_GATEWAY_MGMT_URL      — default: SR_GATEWAY_URL with port 8081
 *   SR_ESCROW_CONTRACT       — TokenPaymentEscrow address (testnet override)
 *   SR_TOKEN_ADDRESS         — SPACE/SPC token address (testnet override)
 *
 * Optional (for combined mode):
 *   MORPH_ACCESS_KEY, MORPH_SECRET_KEY, MORPH_PAYWALL_URL
 *
 * Install peer dep first:
 *   pnpm add @spacenetwork/spacerouter
 */
import { createPaymentClient } from '../src/index.js';

async function main() {
  const cmd = process.argv[2] ?? 'proxy';
  const privateKey = process.env.SR_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Set SR_PRIVATE_KEY first.');
    process.exit(1);
  }

  const client = createPaymentClient({
    chains: ['creditcoin-testnet', 'morph-hoodi-testnet'],
    ows: { wallet: 'spacerouter-demo', privateKey },
    spacerouter: {
      gatewayUrl: process.env.SR_GATEWAY_URL ?? 'https://gateway.spacerouter.org',
      gatewayMgmtUrl: process.env.SR_GATEWAY_MGMT_URL,
      escrowContract: process.env.SR_ESCROW_CONTRACT,
      tokenAddress: process.env.SR_TOKEN_ADDRESS,
      region: 'KR',
      ipType: 'residential',
      autoEscrow: { minBalance: 1n * 10n ** 18n, topUpAmount: 5n * 10n ** 18n, claimThreshold: 10 },
    },
    morph: {
      accessKey: process.env.MORPH_ACCESS_KEY,
      secretKey: process.env.MORPH_SECRET_KEY,
    },
    policy: {
      // 1 GB / hour bandwidth ceiling, residential only.
      bandwidthMaxPerHour: 1_000_000_000n,
      allowedIpTypes: ['residential'],
    },
  });

  try {
    if (cmd === 'proxy') {
      console.log('→ fetching IP via residential proxy (region: KR)…');
      const r = await client.fetchWithPayment('https://httpbin.org/ip', undefined, { proxy: 'spacerouter' });
      console.log('Status:', r.status);
      console.log('Body:', await r.text());
    } else if (cmd === 'smart-fallback') {
      console.log('→ fetching with proxy: auto — should fall back if site bot-blocks…');
      const r = await client.fetchWithPayment('https://httpbin.org/ip', undefined, { proxy: 'auto', region: 'US' });
      console.log('Status:', r.status);
      console.log('Body:', await r.text());
    } else if (cmd === 'combined') {
      const url = process.env.MORPH_PAYWALL_URL;
      if (!url) {
        console.error('Set MORPH_PAYWALL_URL for combined mode.');
        process.exit(1);
      }
      console.log('→ fetchWithPayment via residential proxy + Morph 402 settlement…');
      const r = await client.fetchWithPayment(url, undefined, {
        proxy: 'auto', region: 'US',
        referenceKey: `demo-${Date.now()}`,
      });
      console.log('Status:', r.status);
      console.log('Body:', await r.text());
    } else {
      console.error(`Unknown command: ${cmd}. Try: proxy | smart-fallback | combined`);
      process.exit(1);
    }

    // Audit trail.
    const audit = client.getGuard()?.getAudit().export() ?? [];
    if (audit.length) {
      console.log(`\nAudit log (${audit.length} entries):`);
      for (const e of audit) console.log(` • ${e.type} ${e.url ?? ''} bytes=${e.bytesServed ?? '-'} amount=${e.amount ?? '-'}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
