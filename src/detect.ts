import type { ProtocolType } from './types.js';

/**
 * Detect which payment protocol a 402 response uses based on HTTP headers.
 */
export function detectProtocol(
  response: Response,
  preference: ProtocolType = 'auto',
): 'x402' | 'mpp' | 'xrpl' | 'unknown' {
  const hasX402 =
    response.headers.has('payment-required') ||
    response.headers.has('x-payment-required');

  const hasMpp =
    response.headers.get('www-authenticate')?.toLowerCase().includes('payment') ?? false;

  const hasXrpl = response.headers.has('x-xrpl-payment-required');

  if (hasXrpl) return 'xrpl';

  // Check if payment-required contains xrpl network
  if (hasX402 && preference === 'xrpl') {
    try {
      const header = response.headers.get('payment-required') ?? '';
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      if (decoded.accepts?.[0]?.network?.startsWith('xrpl:')) return 'xrpl';
    } catch { /* not xrpl */ }
  }

  if (hasX402 && hasMpp) {
    return preference === 'mpp' ? 'mpp' : 'x402';
  }
  if (hasX402) return 'x402';
  if (hasMpp) return 'mpp';
  return 'unknown';
}
