import express from 'express';
import { createPaywall, createHealthEndpoint } from '../src/index.js';
import { MOCK_CATALOG } from '../src/bazaar/mock-catalog.js';

const app = express();
app.use(express.json());

const PAY_TO = process.env.PAY_TO ?? '0x0000000000000000000000000000000000000001';

const config = {
  routes: {
    'GET /api/weather': {
      price: '10000',
      description: 'Weather data ($0.01 USDC)',
      x402: { payTo: PAY_TO },
    },
    'POST /api/translate': {
      price: '50000',
      description: 'Translation ($0.05 USDC)',
      x402: { payTo: PAY_TO },
    },
    'POST /api/generate-image': {
      price: '100000',
      description: 'Image generation ($0.10 USDC)',
      x402: { payTo: PAY_TO },
    },
  },
};

app.use(createPaywall(config) as any);
app.get('/health', createHealthEndpoint(config) as any);

app.get('/discovery/resources', (_req, res) => res.json({ items: MOCK_CATALOG }));

app.get('/api/weather', (req, res) => {
  const city = (req.query.city as string) ?? 'San Francisco';
  res.json({ city, temp: 72, conditions: 'sunny', humidity: 45 });
});

app.post('/api/translate', (req, res) => {
  const { text, to } = req.body ?? {};
  res.json({ original: text ?? 'hello', translated: `[${to ?? 'es'}] hola`, language: to ?? 'es' });
});

app.post('/api/generate-image', (req, res) => {
  const { prompt } = req.body ?? {};
  res.json({ prompt: prompt ?? 'a cat', url: `https://placeholder.co/512?text=${encodeURIComponent(prompt ?? 'generated')}`, model: 'mock-v1' });
});

const PORT = Number(process.env.SERVICES_PORT ?? 4021);
app.listen(PORT, () => console.log(`Mock x402 services on http://localhost:${PORT}`));
