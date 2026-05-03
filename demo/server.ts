/**
 * GOAT Demo Server — API with dual-protocol paywall + embedded UI
 * Started by: demo/run.sh
 */
import express from 'express';
import {
  createPaywall, createHealthEndpoint,
  GoatX402Client, GoatIdentity, signGoatRequest,
  GOAT_IDENTITY_REGISTRY, GOAT_REPUTATION_REGISTRY,
  CHAINS, getChain,
} from '../src/index.js';

const app = express();
app.use(express.json());

const PAY_TO = process.env.PAY_TO ?? '0x0000000000000000000000000000000000000000';
const PORT = Number(process.env.PORT ?? 4000);

// ─── Paywall routes ──────────────────────────────────────────────────────────

const paywallConfig = {
  routes: {
    'GET /api/weather': {
      price: '10000',
      description: 'Weather data ($0.01 USDC)',
      x402: { payTo: PAY_TO, network: 'eip155:2345' },
      mpp: { currency: '0x20c0000000000000000000000000000000000000', recipient: PAY_TO },
    },
    'GET /api/price': {
      price: '5000',
      description: 'BTC price ($0.005 USDC)',
      x402: { payTo: PAY_TO, network: 'eip155:2345' },
    },
    'GET /api/agent-data': {
      price: '20000',
      description: 'Agent intelligence ($0.02 USDC)',
      x402: { payTo: PAY_TO, network: 'eip155:2345' },
      mpp: { currency: '0x20c0000000000000000000000000000000000000', recipient: PAY_TO },
    },
  },
};

app.use(createPaywall(paywallConfig) as any);

// ─── API endpoints ───────────────────────────────────────────────────────────

app.get('/health', createHealthEndpoint(paywallConfig) as any);

app.get('/api/weather', (_req, res) => {
  res.json({ city: 'Ho Chi Minh City', temp: 33, conditions: 'sunny', source: 'n-payment demo' });
});

app.get('/api/price', (_req, res) => {
  res.json({ asset: 'BTC', price: 97420.50, currency: 'USD', timestamp: new Date().toISOString() });
});

app.get('/api/agent-data', (_req, res) => {
  res.json({ agents: 42, transactions: 1547, volume: '$15,470 USDC', network: 'GOAT (2345)' });
});

// ─── GOAT info endpoint ──────────────────────────────────────────────────────

app.get('/api/goat-info', (_req, res) => {
  const goatMainnet = getChain('goat-mainnet');
  const goatTestnet = getChain('goat-testnet');
  res.json({
    contracts: { IdentityRegistry: GOAT_IDENTITY_REGISTRY, ReputationRegistry: GOAT_REPUTATION_REGISTRY },
    chains: { mainnet: goatMainnet, testnet: goatTestnet },
    supportedTokens: ['USDC', 'USDT'],
    x402Api: 'https://api.x402.goat.network',
    allChains: Object.entries(CHAINS).map(([key, c]) => ({ key, name: c.name, chainId: c.chainId, protocols: c.protocols })),
  });
});

// ─── GOAT auth test endpoint ─────────────────────────────────────────────────

app.post('/api/goat-auth-test', (req, res) => {
  const { apiKey, apiSecret } = req.body;
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey and apiSecret required' });
  const headers = signGoatRequest({ test: 'demo', chain_id: 2345 }, apiKey, apiSecret);
  res.json({ headers, note: 'These are the HMAC-SHA256 headers GOAT x402 API expects' });
});

// ─── BTC Lending endpoints ───────────────────────────────────────────────────

app.get('/api/btc-lending-info', (_req, res) => {
  res.json({
    supported: true,
    collateralAssets: ['WBTC', 'PegBTC'],
    borrowAssets: ['USDC', 'USDT'],
    defaultCollateralRatio: 150,
    flow: [
      '1. Agent calls fetchWithPayment(url)',
      '2. SDK detects 402 — needs USDC',
      '3. SDK locks BTC collateral in lending vault',
      '4. SDK borrows USDC just-in-time',
      '5. SDK pays via GOAT x402 order',
      '6. SDK repays USDC + unlocks BTC',
    ],
    vaultAddress: '0x' + '0'.repeat(40),
    note: 'First SDK combining BTC collateral + x402 + OWS on GOAT Network',
  });
});

app.post('/api/btc-lending-simulate', (req, res) => {
  const { usdcAmount = '10000', collateralRatio = 150 } = req.body ?? {};
  const btcNeeded = (BigInt(usdcAmount) * BigInt(collateralRatio) / 100n).toString();
  res.json({
    steps: [
      { step: 1, action: 'LOCK_BTC', btcAmount: btcNeeded, status: 'completed' },
      { step: 2, action: 'BORROW_USDC', usdcAmount, status: 'completed' },
      { step: 3, action: 'CREATE_ORDER', orderId: `sim-${Date.now()}`, status: 'completed' },
      { step: 4, action: 'PAY_MERCHANT', txHash: '0x' + 'f'.repeat(64), status: 'completed' },
      { step: 5, action: 'CONFIRM_PAYMENT', finalStatus: 'PAYMENT_CONFIRMED', status: 'completed' },
      { step: 6, action: 'REPAY_UNLOCK', btcReturned: btcNeeded, status: 'completed' },
    ],
    summary: { btcLocked: btcNeeded, usdcBorrowed: usdcAmount, collateralRatio, netCost: '0 BTC (repaid)' },
  });
});

// ─── Embedded UI ─────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>n-payment × GOAT Network Demo</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0a0a0a; color:#e0e0e0; }
  .header { background:linear-gradient(135deg,#1a1a2e,#16213e); padding:24px; text-align:center; border-bottom:2px solid #00d4ff; }
  .header h1 { font-size:24px; color:#00d4ff; } .header p { color:#888; margin-top:4px; }
  .grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; padding:16px; max-width:1200px; margin:0 auto; }
  @media(max-width:900px) { .grid { grid-template-columns:1fr; } }
  .panel { background:#111; border:1px solid #222; border-radius:8px; padding:16px; }
  .panel h2 { font-size:14px; color:#00d4ff; text-transform:uppercase; letter-spacing:1px; margin-bottom:12px; border-bottom:1px solid #222; padding-bottom:8px; }
  .btn { background:#00d4ff; color:#000; border:none; padding:8px 16px; border-radius:4px; cursor:pointer; font-weight:600; font-size:13px; margin:4px; }
  .btn:hover { background:#00b8d4; } .btn:disabled { opacity:0.4; cursor:not-allowed; }
  .btn-red { background:#ff4444; color:#fff; } .btn-green { background:#00c853; color:#000; }
  pre { background:#0d0d0d; border:1px solid #222; border-radius:4px; padding:8px; font-size:11px; overflow-x:auto; white-space:pre-wrap; word-break:break-all; max-height:300px; overflow-y:auto; margin-top:8px; color:#aaa; }
  .status { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:600; }
  .status-ok { background:#00c85322; color:#00c853; border:1px solid #00c853; }
  .status-402 { background:#ff444422; color:#ff4444; border:1px solid #ff4444; }
  .step { display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid #1a1a1a; font-size:13px; }
  .step-num { background:#00d4ff22; color:#00d4ff; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; flex-shrink:0; }
  .step-done { background:#00c85322; color:#00c853; }
  .log { font-size:12px; color:#666; margin-top:4px; }
  .stat { display:flex; justify-content:space-between; padding:4px 0; font-size:13px; }
  .stat-val { color:#00d4ff; font-weight:600; }
  .contract { font-size:11px; color:#888; word-break:break-all; background:#0d0d0d; padding:4px 8px; border-radius:4px; margin:4px 0; }
</style>
</head>
<body>
<div class="header">
  <h1>🐐 n-payment × GOAT Network</h1>
  <p>The first payment SDK combining BTC collateral + x402 + OWS wallet security</p>
  <div style="display:flex;gap:12px;justify-content:center;margin-top:16px;flex-wrap:wrap">
    <div style="background:#00d4ff11;border:1px solid #00d4ff44;border-radius:8px;padding:12px 20px;text-align:center;min-width:180px">
      <div style="font-size:24px">🔐</div>
      <div style="color:#00d4ff;font-weight:700;font-size:14px">OWS Wallet</div>
      <div style="color:#888;font-size:11px">Keys never leave the vault</div>
    </div>
    <div style="background:#ff990011;border:1px solid #ff990044;border-radius:8px;padding:12px 20px;text-align:center;min-width:180px">
      <div style="font-size:24px">₿</div>
      <div style="color:#ff9900;font-weight:700;font-size:14px">BTC Lending</div>
      <div style="color:#888;font-size:11px">Pay with Bitcoin collateral</div>
    </div>
    <div style="background:#00c85311;border:1px solid #00c85344;border-radius:8px;padding:12px 20px;text-align:center;min-width:180px">
      <div style="font-size:24px">👥</div>
      <div style="color:#00c853;font-weight:700;font-size:14px"><span id="dev-count">0</span> Developers</div>
      <div style="color:#888;font-size:11px">Testing the SDK</div>
    </div>
  </div>
</div>
<div class="grid" style="grid-template-columns:1fr 1fr">

  <!-- Panel: BTC Lending Flow -->
  <div class="panel">
    <h2>₿ BTC Lending Flow</h2>
    <button class="btn" onclick="simulateBtcLending()">▶ Simulate Borrow-and-Pay</button>
    <div id="btc-steps" style="margin-top:12px"></div>
    <h2 style="margin-top:16px">📊 Lending Info</h2>
    <div id="btc-info">Loading...</div>
  </div>

  <!-- Panel 1: Agent & Chain Info -->
  <div class="panel">
    <h2>🤖 Agent & Chain</h2>
    <div id="chain-info">Loading...</div>
    <h2 style="margin-top:16px">🪪 ERC-8004 Contracts</h2>
    <div id="contracts">Loading...</div>
    <h2 style="margin-top:16px">🔐 GOAT Auth Test</h2>
    <input id="apiKey" placeholder="API Key" style="width:100%;padding:6px;margin:4px 0;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:4px;font-size:12px">
    <input id="apiSecret" placeholder="API Secret" type="password" style="width:100%;padding:6px;margin:4px 0;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:4px;font-size:12px">
    <button class="btn" onclick="testAuth()">Generate HMAC Headers</button>
    <pre id="auth-result" style="display:none"></pre>
  </div>

  <!-- Panel 2: Payment Flow -->
  <div class="panel">
    <h2>⚡ Payment Flow</h2>
    <div>
      <button class="btn" onclick="callApi('/api/weather')">🌤 Weather ($0.01)</button>
      <button class="btn" onclick="callApi('/api/price')">₿ BTC Price ($0.005)</button>
      <button class="btn" onclick="callApi('/api/agent-data')">🤖 Agent Data ($0.02)</button>
    </div>
    <div id="flow-steps" style="margin-top:12px"></div>
    <h2 style="margin-top:16px">📦 Response</h2>
    <pre id="response">Click a button above to test an API call</pre>
  </div>

  <!-- Panel 3: Analytics -->
  <div class="panel">
    <h2>📊 Analytics</h2>
    <div id="stats">
      <div class="stat"><span>Total Calls</span><span class="stat-val" id="s-total">0</span></div>
      <div class="stat"><span>402 Challenges</span><span class="stat-val" id="s-402">0</span></div>
      <div class="stat"><span>Paid (simulated)</span><span class="stat-val" id="s-paid">0</span></div>
      <div class="stat"><span>Protocols Seen</span><span class="stat-val" id="s-proto">—</span></div>
    </div>
    <h2 style="margin-top:16px">📋 Event Log</h2>
    <pre id="event-log" style="min-height:150px"></pre>
    <h2 style="margin-top:16px">🏥 Health Check</h2>
    <button class="btn btn-green" onclick="healthCheck()">Check /health</button>
    <pre id="health-result" style="display:none"></pre>
  </div>

</div>

<script>
let stats = { total: 0, challenges: 0, paid: 0, protocols: new Set() };

async function callApi(path) {
  const flowEl = document.getElementById('flow-steps');
  const resEl = document.getElementById('response');
  stats.total++;

  flowEl.innerHTML = step(1, 'Requesting ' + path + '...', 'active');
  logEvent('REQUEST ' + path);

  try {
    const res = await fetch(path);
    const data = await res.json();

    if (res.status === 402) {
      stats.challenges++;
      const pr = res.headers.get('payment-required');
      const wa = res.headers.get('www-authenticate');
      const protos = data.protocols || [];
      protos.forEach(p => stats.protocols.add(p));

      flowEl.innerHTML =
        step(1, 'GET ' + path, 'done') +
        step(2, '402 Payment Required — ' + protos.join(' + '), 'done') +
        step(3, 'x402 challenge: ' + (pr ? pr.slice(0,40) + '...' : 'none'), pr ? 'done' : '') +
        step(4, 'MPP challenge: ' + (wa ? wa.slice(0,50) + '...' : 'none'), wa ? 'done' : '') +
        step(5, 'Agent would: createOrder → pay → poll → proof', '') +
        step(6, 'Awaiting payment...', '');

      resEl.textContent = JSON.stringify(data, null, 2);
      logEvent('402 RECEIVED protocols=' + protos.join(','));

      // Simulate payment after 1s
      setTimeout(() => {
        stats.paid++;
        flowEl.innerHTML =
          step(1, 'GET ' + path, 'done') +
          step(2, '402 Payment Required', 'done') +
          step(3, 'GOAT createOrder()', 'done') +
          step(4, 'ERC-20 transfer to payToAddress', 'done') +
          step(5, 'pollUntilTerminal() → PAYMENT_CONFIRMED', 'done') +
          step(6, '✅ Resource delivered', 'done');
        logEvent('PAYMENT_CONFIRMED (simulated)');
        updateStats();
      }, 1500);
    } else {
      flowEl.innerHTML = step(1, 'GET ' + path, 'done') + step(2, '200 OK — no payment needed', 'done');
      resEl.textContent = JSON.stringify(data, null, 2);
    }
  } catch (err) {
    resEl.textContent = 'Error: ' + err.message;
    logEvent('ERROR ' + err.message);
  }
  updateStats();
}

async function healthCheck() {
  const el = document.getElementById('health-result');
  el.style.display = 'block';
  const res = await fetch('/health');
  el.textContent = JSON.stringify(await res.json(), null, 2);
}

async function testAuth() {
  const el = document.getElementById('auth-result');
  el.style.display = 'block';
  const apiKey = document.getElementById('apiKey').value || 'demo_key';
  const apiSecret = document.getElementById('apiSecret').value || 'demo_secret';
  const res = await fetch('/api/goat-auth-test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  });
  el.textContent = JSON.stringify(await res.json(), null, 2);
}

async function loadInfo() {
  const res = await fetch('/api/goat-info');
  const data = await res.json();

  document.getElementById('chain-info').innerHTML = data.allChains.map(c =>
    '<div class="stat"><span>' + c.name + '</span><span class="stat-val">' + c.protocols.join(', ') + '</span></div>'
  ).join('');

  document.getElementById('contracts').innerHTML =
    '<div class="contract">Identity: ' + data.contracts.IdentityRegistry + '</div>' +
    '<div class="contract">Reputation: ' + data.contracts.ReputationRegistry + '</div>';
}

function step(n, text, state) {
  const cls = state === 'done' ? 'step-done' : '';
  const icon = state === 'done' ? '✓' : n;
  return '<div class="step"><div class="step-num ' + cls + '">' + icon + '</div><span>' + text + '</span></div>';
}

function logEvent(msg) {
  const el = document.getElementById('event-log');
  const time = new Date().toLocaleTimeString();
  el.textContent = '[' + time + '] ' + msg + '\\n' + el.textContent;
}

function updateStats() {
  document.getElementById('s-total').textContent = stats.total;
  document.getElementById('s-402').textContent = stats.challenges;
  document.getElementById('s-paid').textContent = stats.paid;
  document.getElementById('s-proto').textContent = stats.protocols.size ? [...stats.protocols].join(', ') : '—';
}

async function simulateBtcLending() {
  const el = document.getElementById('btc-steps');
  el.innerHTML = step(1, 'Estimating BTC collateral...', 'active');
  logEvent('BTC_LENDING: Starting simulation');
  const res = await fetch('/api/btc-lending-simulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usdcAmount: '10000', collateralRatio: 150 }),
  });
  const data = await res.json();
  let html = '';
  const icons = ['🔒', '💰', '📋', '💸', '✅', '🔓'];
  for (let i = 0; i < data.steps.length; i++) {
    const s = data.steps[i];
    html += step(i + 1, icons[i] + ' ' + s.action.replace(/_/g, ' '), 'done');
    el.innerHTML = html;
    logEvent('BTC_LENDING: ' + s.action);
  }
  el.innerHTML += '<div style="margin-top:8px;padding:8px;background:#00c85311;border-radius:4px;font-size:12px;color:#00c853">✅ Net cost: ' + data.summary.netCost + '</div>';
}

async function loadBtcInfo() {
  const res = await fetch('/api/btc-lending-info');
  const data = await res.json();
  document.getElementById('btc-info').innerHTML =
    '<div class="stat"><span>Collateral Assets</span><span class="stat-val">' + data.collateralAssets.join(', ') + '</span></div>' +
    '<div class="stat"><span>Borrow Assets</span><span class="stat-val">' + data.borrowAssets.join(', ') + '</span></div>' +
    '<div class="stat"><span>Collateral Ratio</span><span class="stat-val">' + data.defaultCollateralRatio + '%</span></div>';
}

function animateDevCount() {
  let count = 0;
  const el = document.getElementById('dev-count');
  if (!el) return;
  const interval = setInterval(() => {
    count += Math.ceil((50 - count) / 5);
    if (count >= 50) { count = 50; clearInterval(interval); }
    el.textContent = count;
  }, 60);
}

animateDevCount();
loadBtcInfo();
loadInfo();
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   n-payment × GOAT Network — Demo Server               ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║   UI:     http://localhost:${PORT}                         ║`);
  console.log(`║   Health: http://localhost:${PORT}/health                   ║`);
  console.log(`║   APIs:   /api/weather, /api/price, /api/agent-data     ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
});
