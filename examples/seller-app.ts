import express from 'express';
import { createPaywall, createHealthEndpoint } from '../src/index.js';

const app = express();
const config = {
  routes: {
    'GET /api/data': {
      price: '10000',
      description: 'Premium data',
      x402: { payTo: process.env.PAY_TO ?? '0x0000000000000000000000000000000000000001' },
    },
  },
};

app.use(createPaywall(config) as any);
app.get('/health', createHealthEndpoint(config) as any);
app.get('/api/data', (_req, res) => res.json({ result: 'paid content' }));
app.listen(3000, () => console.log('Seller API: http://localhost:3000'));
