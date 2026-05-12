import type { ProtocolType } from './types.js';

/**
 * Detect which payment protocol a 402 response uses based on HTTP headers.
 */
export function detectProtocol(
  response: Response,
  preference: ProtocolType = 'auto',
): 'x402' | 'mpp' | 'xrpl' | 'stellar-x402' | 'stellar-mpp' | 'unknown' {
  const paymentHeader = response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
  const authHeader = response.headers.get('www-authenticate') ?? '';
  const hasX402 = !!paymentHeader;
  const hasMpp = authHeader.toLowerCase().includes('payment');
  const hasXrpl = response.headers.has('x-xrpl-payment-required');

  if (hasXrpl) return 'xrpl';

  // Stellar x402: payment-required header with stellar: network
  if (hasX402) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
      if (decoded.accepts?.[0]?.network?.startsWith('stellar:')) return 'stellar-x402';
      if (decoded.accepts?.[0]?.network?.startsWith('xrpl:')) return 'xrpl';
    } catch { /* not base64 JSON */ }
  }

  // Stellar MPP: www-authenticate with stellar keyword
  if (hasMpp && authHeader.toLowerCase().includes('stellar')) return 'stellar-mpp';

  if (hasX402 && hasMpp) return preference === 'mpp' ? 'mpp' : 'x402';
  if (hasX402) return 'x402';
  if (hasMpp) return 'mpp';
  return 'unknown';
}
