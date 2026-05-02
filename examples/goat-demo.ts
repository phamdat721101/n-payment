/**
 * n-payment × GOAT Network — Full Demo
 *
 * Demonstrates the complete GOAT x402 + ERC-8004 flow:
 *   1. Register agent identity (ERC-8004)
 *   2. Create payment order (GOAT x402)
 *   3. Poll order status
 *   4. Retrieve settlement proof
 *   5. Show analytics
 *
 * Usage:
 *   PRIVATE_KEY=0x... \
 *   GOAT_API_KEY=... \
 *   GOAT_API_SECRET=... \
 *   GOAT_MERCHANT_ID=... \
 *   npx tsx examples/goat-demo.ts
 *
 * For local dev with GOAT demo backend:
 *   GOAT_API_URL=http://localhost:8286 npx tsx examples/goat-demo.ts
 */

import {
  GoatX402Client,
  GoatIdentity,
  signGoatRequest,
  GOAT_IDENTITY_REGISTRY,
  GOAT_REPUTATION_REGISTRY,
  CHAINS,
  getChain,
} from '../src/index.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? '';
const GOAT_API_KEY = process.env.GOAT_API_KEY ?? '';
const GOAT_API_SECRET = process.env.GOAT_API_SECRET ?? '';
const GOAT_MERCHANT_ID = process.env.GOAT_MERCHANT_ID ?? '';
const GOAT_API_URL = process.env.GOAT_API_URL ?? 'https://api.x402.goat.network';
const CHAIN = process.env.GOAT_CHAIN === 'mainnet' ? 'goat-mainnet' : 'goat-testnet';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(icon: string, msg: string, data?: unknown) {
  console.log(`\n${icon}  ${msg}`);
  if (data) console.log('   ', JSON.stringify(data, null, 2).split('\n').join('\n    '));
}

function check(name: string, value: string) {
  if (!value) {
    console.error(`\n❌ Missing env var: ${name}`);
    console.error(`   Set it: export ${name}=your_value\n`);
    process.exit(1);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   n-payment × GOAT Network — Full Demo                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  // ── Step 0: Validate config ─────────────────────────────────────────────
  check('PRIVATE_KEY', PRIVATE_KEY);
  check('GOAT_API_KEY', GOAT_API_KEY);
  check('GOAT_API_SECRET', GOAT_API_SECRET);
  check('GOAT_MERCHANT_ID', GOAT_MERCHANT_ID);

  const chain = getChain(CHAIN as any);
  log('⛓️', `Chain: ${chain.name} (${chain.chainId})`, {
    rpc: chain.rpcUrl,
    facilitator: chain.facilitator,
    tokens: Object.keys(chain.tokens),
  });

  // ── Step 1: Show ERC-8004 contracts ─────────────────────────────────────
  log('🪪', 'ERC-8004 Agent Identity Contracts', {
    IdentityRegistry: GOAT_IDENTITY_REGISTRY,
    ReputationRegistry: GOAT_REPUTATION_REGISTRY,
    chain: 'GOAT Mainnet (2345)',
  });

  const identity = new GoatIdentity(PRIVATE_KEY, chain.rpcUrl);
  log('✅', 'GoatIdentity initialized (registerAgent, giveFeedback, getSummary ready)');

  // ── Step 2: Create GOAT x402 client ─────────────────────────────────────
  const goat = new GoatX402Client({
    apiKey: GOAT_API_KEY,
    apiSecret: GOAT_API_SECRET,
    merchantId: GOAT_MERCHANT_ID,
    apiUrl: GOAT_API_URL,
  });
  log('✅', 'GoatX402Client initialized', { apiUrl: GOAT_API_URL, merchantId: GOAT_MERCHANT_ID });

  // ── Step 3: Test HMAC auth ──────────────────────────────────────────────
  const testBody = { dapp_order_id: 'demo-1', chain_id: chain.chainId, token_symbol: 'USDC' };
  const headers = signGoatRequest(testBody, GOAT_API_KEY, GOAT_API_SECRET);
  log('🔐', 'HMAC-SHA256 auth headers generated', {
    'X-API-Key': headers['X-API-Key'],
    'X-Timestamp': headers['X-Timestamp'],
    'X-Sign': headers['X-Sign'].slice(0, 16) + '...',
  });

  // ── Step 4: Create order (dry run) ──────────────────────────────────────
  log('📋', 'Order creation params (would send to GOAT API)', {
    endpoint: `${GOAT_API_URL}/api/v1/orders`,
    method: 'POST',
    body: {
      dapp_order_id: `demo-${Date.now()}`,
      chain_id: chain.chainId,
      token_symbol: 'USDC',
      from_address: '0x' + PRIVATE_KEY.slice(2, 10) + '...',
      amount_wei: '10000',
      merchant_id: GOAT_MERCHANT_ID,
    },
  });

  // ── Step 5: Demonstrate full order lifecycle ────────────────────────────
  log('🔄', 'Full GOAT x402 order lifecycle:');
  console.log(`
    ┌─────────────────────────────────────────────────────────┐
    │  1. createOrder()     → POST /api/v1/orders             │
    │     Returns: orderId, payToAddress, flow, status         │
    │                                                         │
    │  2. [User/Agent sends ERC-20 to payToAddress]           │
    │                                                         │
    │  3. pollUntilTerminal() → GET /api/v1/orders/{id}       │
    │     CHECKOUT_VERIFIED → PAYMENT_CONFIRMED → INVOICED    │
    │                                                         │
    │  4. getOrderProof()   → GET /api/v1/orders/{id}/proof   │
    │     Returns: { payload, signature }                     │
    │                                                         │
    │  5. cancelOrder()     → POST /api/v1/orders/{id}/cancel │
    │     Only for CHECKOUT_VERIFIED (refunds fee)            │
    └─────────────────────────────────────────────────────────┘
  `);

  // ── Step 6: Live API test (if credentials are real) ─────────────────────
  if (process.env.GOAT_LIVE_TEST === 'true') {
    log('🚀', 'LIVE TEST — Creating real order on GOAT...');
    try {
      const { privateKeyToAccount } = await import('viem/accounts');
      const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

      const order = await goat.createOrder({
        dappOrderId: `demo-${Date.now()}`,
        chainId: chain.chainId,
        tokenSymbol: 'USDC',
        fromAddress: account.address,
        amountWei: '10000', // 0.01 USDC (6 decimals)
      });

      log('📦', 'Order created!', {
        orderId: order.orderId,
        payToAddress: order.payToAddress,
        flow: order.flow,
        status: order.status,
        amountWei: order.amountWei,
      });

      log('⏳', 'Polling order status (timeout: 30s)...');
      const finalStatus = await goat.pollUntilTerminal(order.orderId, 30_000, 3_000);
      log('📊', `Final status: ${finalStatus}`);

      if (finalStatus === 'PAYMENT_CONFIRMED' || finalStatus === 'INVOICED') {
        const proof = await goat.getOrderProof(order.orderId);
        log('🔏', 'Settlement proof retrieved', {
          txHash: proof.payload.tx_hash,
          flow: proof.payload.flow,
          signature: proof.signature.slice(0, 20) + '...',
        });
      }
    } catch (err: any) {
      log('⚠️', `Order flow error: ${err.message}`, { code: err.code, hint: err.hint });
    }
  } else {
    log('💡', 'Set GOAT_LIVE_TEST=true to run a real order against the GOAT API');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║   Demo Complete                                        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║                                                        ║');
  console.log('║   SDK Exports Used:                                    ║');
  console.log('║   • GoatX402Client  — order lifecycle                  ║');
  console.log('║   • GoatIdentity    — ERC-8004 agent identity          ║');
  console.log('║   • signGoatRequest — HMAC-SHA256 auth                 ║');
  console.log('║   • CHAINS / getChain — chain registry                 ║');
  console.log('║                                                        ║');
  console.log('║   Next Steps:                                          ║');
  console.log('║   • Apply: https://tally.so/r/EkJo42                  ║');
  console.log('║   • Docs:  https://docs.goat.network/builders/x402    ║');
  console.log('║   • Repo:  https://github.com/GOATNetwork/x402        ║');
  console.log('║                                                        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch(console.error);
