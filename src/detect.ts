import type { ProtocolType } from './types.js';

/**
 * Detect which payment protocol a 402 response uses based on HTTP headers.
 *
 * - `payment-required` or `x-payment-required` header → x402
 * - `www-authenticate` containing "Payment" → mpp
 * - Both present → use preference (default: x402)
 */
export function detectProtocol(
  response: Response,
  preference: ProtocolType = 'auto',
): 'x402' | 'mpp' | 'unknown' {
  const hasX402 =
    response.headers.has('payment-required') ||
    response.headers.has('x-payment-required');

  const hasMpp =
    response.headers.get('www-authenticate')?.toLowerCase().includes('payment') ?? false;

  if (hasX402 && hasMpp) {
    return preference === 'mpp' ? 'mpp' : 'x402';
  }
  if (hasX402) return 'x402';
  if (hasMpp) return 'mpp';
  return 'unknown';
}
