import type { BazaarResource } from '../types.js';

export const MOCK_CATALOG: BazaarResource[] = [
  {
    resource: 'http://localhost:4021/api/weather',
    type: 'http',
    description: 'Weather data for any city',
    accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', maxAmountRequired: '10000', payTo: '0x0000000000000000000000000000000000000001' }],
  },
  {
    resource: 'http://localhost:4021/api/translate',
    type: 'http',
    description: 'Translate text between languages',
    accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', maxAmountRequired: '50000', payTo: '0x0000000000000000000000000000000000000001' }],
  },
  {
    resource: 'http://localhost:4021/api/generate-image',
    type: 'http',
    description: 'Generate image from text prompt',
    accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', maxAmountRequired: '100000', payTo: '0x0000000000000000000000000000000000000001' }],
  },
];
