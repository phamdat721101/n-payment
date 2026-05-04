import { createPaymentClient, createBazaarClient } from '../src/index.js';

const bazaar = createBazaarClient({ mockCatalog: true });
const client = createPaymentClient({
  chains: ['base-sepolia'],
  ows: { wallet: process.env.OWS_WALLET ?? 'my-agent' },
});

// Discover
const services = await bazaar.listServices();
console.log('Available services:', services.map((s) => s.description));

// Search + pay
const { resources } = await bazaar.search('weather');
if (resources.length) {
  console.log('Paying for:', resources[0].resource);
  const res = await client.fetchWithPayment(resources[0].resource);
  console.log('Response:', await res.json());
}
