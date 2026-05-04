import { createBazaarClient, MockMoonPayAdapter, OffRampClient } from '../src/index.js';
import type { BazaarResource } from '../src/types.js';

const C = { reset: '\x1b[0m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };
const log = (icon: string, msg: string) => console.log(`${C.cyan}${icon}${C.reset}  ${msg}`);
const step = (n: number, msg: string) => console.log(`\n${C.bold}[${n}/10]${C.reset} ${C.green}${msg}${C.reset}`);

function priceUSDC(atomicUnits: string): string {
  return `$${(Number(atomicUnits) / 1e6).toFixed(2)} USDC`;
}

function printService(s: BazaarResource, i: number) {
  const price = s.accepts[0]?.maxAmountRequired ?? '0';
  console.log(`  ${C.dim}${i + 1}.${C.reset} ${s.description ?? s.resource} ${C.yellow}${priceUSDC(price)}${C.reset}`);
  console.log(`     ${C.dim}${s.resource}${C.reset}`);
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   n-payment v0.4 — AI Agent Payment Demo            ║');
  console.log('║   Discover → Pay → Consume → Off-Ramp               ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  // Step 1: Create discovery client
  step(1, 'Creating BazaarClient (mock catalog for testnet)');
  const bazaar = createBazaarClient({ mockCatalog: true });
  log('✅', 'BazaarClient ready');

  // Step 2: List all services
  step(2, 'Discovering available paid services...');
  const services = await bazaar.listServices();
  log('📚', `Found ${services.length} services:`);
  services.forEach(printService);

  // Step 3: Search for weather
  step(3, 'Searching for "weather" service...');
  const result = await bazaar.search('weather');
  log('🔍', `Search returned ${result.total} result(s)`);
  result.resources.forEach((s, i) => printService(s, i));

  // Step 4: Select service
  step(4, 'Selecting weather service for payment');
  const selected = result.resources[0];
  const price = selected.accepts[0]?.maxAmountRequired ?? '0';
  log('🎯', `Target: ${selected.resource}`);
  log('💰', `Price: ${priceUSDC(price)}`);

  // Step 5: Create payment client (mock mode)
  step(5, 'Creating PaymentClient with OWS wallet');
  log('🔐', 'Wallet: my-agent (OWS — keys never leave vault)');
  log('⛓️', 'Chain: Base Sepolia (eip155:84532)');
  log('ℹ️', 'In production: fetchWithPayment() auto-handles 402 → sign → retry');

  // Step 6: Simulate payment
  step(6, 'Paying for weather service...');
  const start = Date.now();
  // In real mode: await client.fetchWithPayment(selected.resource)
  // Demo mode: simulate the flow
  await new Promise((r) => setTimeout(r, 300));
  const durationMs = Date.now() - start;
  log('✅', `Payment completed in ${durationMs}ms`);

  // Step 7: Consume service
  step(7, 'Consuming weather API response');
  const mockResponse = { city: 'San Francisco', temp: 72, conditions: 'sunny', humidity: 45 };
  console.log(`  ${C.dim}${JSON.stringify(mockResponse, null, 2)}${C.reset}`);

  // Step 8: Analytics
  step(8, 'Payment analytics');
  console.log(`  Protocol:  x402 (exact scheme)`);
  console.log(`  Chain:     Base Sepolia`);
  console.log(`  Cost:      ${priceUSDC(price)}`);
  console.log(`  Duration:  ${durationMs}ms`);
  console.log(`  Tx:        0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`);

  // Step 9: Off-ramp quote
  step(9, 'Getting off-ramp quote (MockMoonPay)');
  const offramp = new OffRampClient(new MockMoonPayAdapter());
  const currencies = await offramp.getSupportedCurrencies();
  log('🌍', `Supported: ${currencies.join(', ')}`);
  const quote = await offramp.getQuote({ amount: '100.00', token: 'USDC', chain: 'base-sepolia', fiatCurrency: 'USD' });
  log('💱', `$100 USDC → $${quote.fiatAmount} USD (${quote.feePercent}% fee, ~${quote.estimatedDays} days)`);

  // Step 10: Mock withdrawal
  step(10, 'Executing mock off-ramp withdrawal');
  const receipt = await offramp.withdraw({ amount: '100.00', token: 'USDC', chain: 'base-sepolia', destination: { type: 'bank_account', id: 'demo-bank-001' } });
  log('🏦', `Withdrawal ${receipt.id}: ${receipt.status}`);
  log('📅', `Estimated arrival: ${receipt.estimatedArrival.split('T')[0]}`);

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║   ✅ Demo Complete                                    ║');
  console.log('╠════════════════════════════════════════════════════════╣');
  console.log('║   Testnet: npx tsx demo/cli-demo.ts                ║');
  console.log('║   Mainnet: Set CDP_API_KEY + OWS_WALLET            ║');
  console.log('║   Install: npm install n-payment                   ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
