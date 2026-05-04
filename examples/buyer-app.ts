import { createPaymentClient } from '../src/index.js';

const client = createPaymentClient({
  chains: ['base-sepolia'],
  ows: { wallet: process.env.OWS_WALLET ?? 'my-agent' },
});

const res = await client.fetchWithPayment('https://api.example.com/data');
console.log('Status:', res.status);
console.log('Data:', await res.json());
