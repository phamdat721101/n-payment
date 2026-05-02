import { createPaymentClient } from '../src/index.js';

const client = createPaymentClient({
  chains: ['goat-testnet'],
  ows: { wallet: process.env.OWS_WALLET ?? 'goat-agent' },
  goat: {
    apiKey: process.env.GOAT_API_KEY!,
    apiSecret: process.env.GOAT_API_SECRET!,
    merchantId: process.env.GOAT_MERCHANT_ID!,
    apiUrl: 'https://api.x402.goat.network',
  },
});

console.log('GOAT payment client created with OWS wallet (no private key exposure)');
