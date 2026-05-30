import type { ProtocolType } from './types.js';

const MORPH_NETWORKS = new Set(['eip155:2818', 'eip155:2910']);
const FLARE_NETWORKS = new Set([
  'flare-coston2', 'flare-songbird', 'flare',
  'eip155:114', 'eip155:19', 'eip155:14',
]);

/**
 * Detect which payment protocol a 402 response uses based on HTTP headers and challenge body.
 */
export function detectProtocol(
  response: Response,
  preference: ProtocolType = 'auto',
): 'x402' | 'mpp' | 'xrpl' | 'stellar-x402' | 'stellar-mpp' | 'morph-x402' | 'flare-x402' | 'unknown' {
  const paymentHeader = response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
  const authHeader = response.headers.get('www-authenticate') ?? '';
  const hasX402 = !!paymentHeader;
  const hasMpp = authHeader.toLowerCase().includes('payment');
  const hasXrpl = response.headers.has('x-xrpl-payment-required');

  if (hasXrpl) return 'xrpl';

  if (hasX402) {
    try {
      const network = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())?.accepts?.[0]?.network as string | undefined;
      if (network && FLARE_NETWORKS.has(network)) return 'flare-x402';
      if (network && MORPH_NETWORKS.has(network)) return 'morph-x402';
      if (network?.startsWith('stellar:')) return 'stellar-x402';
      if (network?.startsWith('xrpl:')) return 'xrpl';
    } catch { /* not base64 JSON — fall through */ }
  }

  if (hasMpp && authHeader.toLowerCase().includes('stellar')) return 'stellar-mpp';

  if (hasX402 && hasMpp) return preference === 'mpp' ? 'mpp' : 'x402';
  if (hasX402) return 'x402';
  if (hasMpp) return 'mpp';
  return 'unknown';
}
