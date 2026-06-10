/**
 * v0.25 — Celo CIP-64 fee-abstracted x402 demo.
 *
 *   pnpm tsx examples/celo-x402-demo.ts buyer
 *   pnpm tsx examples/celo-x402-demo.ts merchant
 *
 * Buyer mode: spins up a PaymentClient on celo-sepolia and calls
 *   `fetchWithPayment(MERCHANT_URL)` — the agent never holds CELO; gas is
 *   paid in the same USDC the agent is paying with. Prints the final
 *   Agent Visa tier and the on-chain Celoscan link.
 *
 * Merchant mode: spins up an Express server with a paywalled route that
 *   verifies and settles inbound EIP-3009 authorizations via
 *   CeloFeeAbstractedAdapter.verifyAndSettle (facilitator wallet also
 *   pays gas in USDC).
 *
 * Required env:
 *   CELO_PRIVATE_KEY     — hex-encoded wallet key (funded with Celo Sepolia USDC)
 *   CELO_MERCHANT_URL    — buyer mode only; merchant URL emitting an x402 challenge
 *   CELO_MERCHANT_ADDR   — merchant mode only; payTo address
 *   PORT                 — merchant mode only; default 3035
 */
import { createPaymentClient, CeloFeeAbstractedAdapter, OWSWallet } from '../src/index.js';
import type { Hex } from 'viem';

const MODE = process.argv[2] ?? 'buyer';
const PRIV = process.env.CELO_PRIVATE_KEY as Hex | undefined;

if (!PRIV) {
  console.error('CELO_PRIVATE_KEY env var is required (Celo Sepolia funded wallet).');
  process.exit(1);
}

async function buyer(): Promise<void> {
  const url = process.env.CELO_MERCHANT_URL;
  if (!url) {
    console.error('CELO_MERCHANT_URL env var is required in buyer mode.');
    process.exit(1);
  }
  const client = createPaymentClient({
    chains: ['celo-sepolia'],
    ows: { wallet: 'celo-buyer', privateKey: PRIV },
    celo: { network: 'sepolia', payAsset: 'USDC' },
  });

  const before = await client.getCeloVisaStatus();
  console.log('Tier before:', before?.tier ?? 'none', '(txCount:', before?.txCount ?? 0, ')');

  console.log(`→ fetchWithPayment(${url})`);
  const res = await client.fetchWithPayment(url);
  console.log(`← ${res.status} ${res.statusText}`);
  console.log('Body preview:', (await res.text()).slice(0, 200));

  const after = await client.getCeloVisaStatus();
  console.log('Tier after :', after?.tier, '(txCount:', after?.txCount, ')');
  console.log('Volume USD :', after?.volumeUsd);
}

async function merchant(): Promise<void> {
  const payTo = process.env.CELO_MERCHANT_ADDR;
  if (!payTo) {
    console.error('CELO_MERCHANT_ADDR env var is required in merchant mode.');
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 3035);

  // Minimal HTTP server using Node's built-in http — keeps the example free
  // of express peer-dep. Production merchants integrate with createPaywall.
  const http = await import('node:http');
  const wallet = new OWSWallet({ wallet: 'celo-merchant', privateKey: PRIV });
  const adapter = new CeloFeeAbstractedAdapter(wallet, 'celo-sepolia', { payAsset: 'USDC' });
  adapter.setMerchantSigner(PRIV!, 'USDC');

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/api/data') {
      res.writeHead(404).end('not found');
      return;
    }

    const xPayment = req.headers['x-payment'] as string | undefined;
    if (!xPayment) {
      // Emit a 402 challenge for 0.01 USDC.
      const envelope = {
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:11142220',
          maxAmountRequired: '10000', // 0.01 USDC (6 dec)
          asset: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
          payTo,
          resource: req.url,
        }],
      };
      const headerB64 = Buffer.from(JSON.stringify(envelope)).toString('base64');
      res.writeHead(402, { 'payment-required': headerB64 }).end();
      return;
    }

    try {
      const decoded = CeloFeeAbstractedAdapter.decodeXPayment(xPayment);
      const settlement = await adapter.verifyAndSettle({
        authorization: decoded.authorization,
        signature: decoded.signature,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'x-settlement-tx': settlement.txHash }).end(
        JSON.stringify({ ok: true, settlement }),
      );
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(
        JSON.stringify({ ok: false, error: (e as Error).message }),
      );
    }
  });

  server.listen(port, () => {
    console.log(`Celo CIP-64 paywall listening on http://localhost:${port}/api/data`);
    console.log('  payTo:', payTo);
    console.log('  facilitator pays gas in USDC via fee-currency adapter 0x4822...1dC0');
  });
}

void (async () => {
  if (MODE === 'buyer') await buyer();
  else if (MODE === 'merchant') await merchant();
  else {
    console.error('Usage: tsx examples/celo-x402-demo.ts [buyer|merchant]');
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
