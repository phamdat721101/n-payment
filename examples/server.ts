/**
 * Example: Express server with dual-protocol paywall
 *
 * Usage:
 *   PAY_TO=0x... npx tsx examples/server.ts
 *   curl http://localhost:3000/api/weather     → 402 with dual challenges
 *   curl http://localhost:3000/health          → pricing info
 */
import express from 'express';
import { createPaywall, createHealthEndpoint } from '../src/index.js';

const app = express();

const config = {
  routes: {
    'GET /api/weather': {
      price: '10000', // 0.01 USDC (6 decimals)
      description: 'Weather data',
      x402: { payTo: process.env.PAY_TO ?? '0x0000000000000000000000000000000000000000' },
      mpp: { currency: '0x20c0000000000000000000000000000000000000', recipient: process.env.PAY_TO ?? '' },
    },
  },
};

app.use(createPaywall(config) as any);
app.get('/health', createHealthEndpoint(config) as any);
app.get('/api/weather', (_req, res) => res.json({ city: 'San Francisco', temp: 72, conditions: 'sunny' }));

app.listen(3000, () => console.log('Dual-protocol API on http://localhost:3000'));
