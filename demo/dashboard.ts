import express from 'express';
import { createBazaarClient, MockMoonPayAdapter, OffRampClient } from '../src/index.js';

const app = express();
const clients: express.Response[] = [];

function broadcast(event: { type: string; data: unknown }) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  clients.forEach((c) => c.write(msg));
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.push(res);
  req.on('close', () => { const i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
});

app.post('/run-demo', async (_req, res) => {
  try {
    broadcast({ type: 'step', data: { n: 1, msg: 'Creating BazaarClient...' } });
    const bazaar = createBazaarClient({ mockCatalog: true });

    broadcast({ type: 'step', data: { n: 2, msg: 'Discovering services...' } });
    const services = await bazaar.listServices();
    broadcast({ type: 'services', data: services });

    broadcast({ type: 'step', data: { n: 3, msg: 'Searching for weather...' } });
    const result = await bazaar.search('weather');
    broadcast({ type: 'search', data: result });

    broadcast({ type: 'step', data: { n: 4, msg: 'Paying for service...' } });
    await new Promise((r) => setTimeout(r, 500));
    broadcast({ type: 'payment', data: { protocol: 'x402', chain: 'Base Sepolia', cost: '$0.01', duration: '320ms', tx: '0x' + Array(16).fill(0).map(() => Math.floor(Math.random()*16).toString(16)).join('') } });

    broadcast({ type: 'step', data: { n: 5, msg: 'Consuming API response...' } });
    broadcast({ type: 'response', data: { city: 'San Francisco', temp: 72, conditions: 'sunny' } });

    broadcast({ type: 'step', data: { n: 6, msg: 'Getting off-ramp quote...' } });
    const offramp = new OffRampClient(new MockMoonPayAdapter());
    const quote = await offramp.getQuote({ amount: '100.00', token: 'USDC', chain: 'base-sepolia', fiatCurrency: 'USD' });
    broadcast({ type: 'offramp', data: quote });

    broadcast({ type: 'done', data: { msg: 'Demo complete!' } });
    res.json({ ok: true });
  } catch (err: any) {
    broadcast({ type: 'error', data: { msg: err.message } });
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(HTML);
});

const PORT = Number(process.env.DASHBOARD_PORT ?? 4022);
app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));

const HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>n-payment Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:20px}
h1{font-size:1.5rem;margin-bottom:16px;color:#fff}h2{font-size:1rem;color:#888;margin-bottom:8px;text-transform:uppercase;letter-spacing:1px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1200px;margin:0 auto}
.panel{background:#141414;border:1px solid #222;border-radius:8px;padding:16px;min-height:200px}
.log{font-family:monospace;font-size:0.85rem;line-height:1.6;max-height:400px;overflow-y:auto}
.log .step{color:#4ade80}.log .info{color:#60a5fa}.log .warn{color:#fbbf24}.log .err{color:#f87171}
pre{background:#1a1a1a;padding:8px;border-radius:4px;overflow-x:auto;font-size:0.8rem;color:#a0a0a0}
btn,button{background:#2563eb;color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:1rem;margin-bottom:16px}
btn:hover,button:hover{background:#1d4ed8}
.badge{display:inline-block;background:#1e3a5f;color:#60a5fa;padding:2px 8px;border-radius:4px;font-size:0.75rem;margin:2px}
</style></head><body>
<h1>💳 n-payment v0.4 — Agent Payment Dashboard</h1>
<button onclick="runDemo()">Run Demo</button>
<div class="grid">
  <div class="panel"><h2>📚 Service Catalog</h2><div id="catalog"><p style="color:#666">Click Run Demo to discover services</p></div></div>
  <div class="panel"><h2>⚡ Agent Activity</h2><div id="activity" class="log"></div></div>
  <div class="panel"><h2>💰 Payment Details</h2><div id="payment"><p style="color:#666">Waiting...</p></div></div>
  <div class="panel"><h2>🏦 Off-Ramp</h2><div id="offramp"><p style="color:#666">Waiting...</p></div></div>
</div>
<script>
const es = new EventSource('/events');
es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  const act = document.getElementById('activity');
  if (ev.type === 'step') act.innerHTML += '<div class="step">[' + ev.data.n + '] ' + ev.data.msg + '</div>';
  if (ev.type === 'services') {
    document.getElementById('catalog').innerHTML = ev.data.map(s =>
      '<div style="margin:8px 0"><b>' + (s.description||s.resource) + '</b><br><span class="badge">$' + (Number(s.accepts[0].maxAmountRequired)/1e6).toFixed(2) + ' USDC</span> <span class="badge">' + s.type + '</span></div>'
    ).join('');
    act.innerHTML += '<div class="info">Found ' + ev.data.length + ' services</div>';
  }
  if (ev.type === 'search') act.innerHTML += '<div class="info">Search: ' + ev.data.total + ' result(s)</div>';
  if (ev.type === 'payment') {
    document.getElementById('payment').innerHTML = '<pre>' + JSON.stringify(ev.data, null, 2) + '</pre>';
    act.innerHTML += '<div class="step">✅ Payment: ' + ev.data.cost + ' via ' + ev.data.protocol + '</div>';
  }
  if (ev.type === 'response') act.innerHTML += '<div class="info">Response: ' + JSON.stringify(ev.data) + '</div>';
  if (ev.type === 'offramp') {
    document.getElementById('offramp').innerHTML = '<pre>' + JSON.stringify(ev.data, null, 2) + '</pre>';
    act.innerHTML += '<div class="warn">Off-ramp: $' + ev.data.fiatAmount + ' ' + ev.data.fiatCurrency + '</div>';
  }
  if (ev.type === 'done') act.innerHTML += '<div class="step">🎉 ' + ev.data.msg + '</div>';
  if (ev.type === 'error') act.innerHTML += '<div class="err">❌ ' + ev.data.msg + '</div>';
  act.scrollTop = act.scrollHeight;
};
function runDemo() { fetch('/run-demo', { method: 'POST' }); }
</script></body></html>`;
