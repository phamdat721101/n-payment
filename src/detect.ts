import type { ProtocolType } from './types.js';

const MORPH_NETWORKS = new Set(['eip155:2818', 'eip155:2910']);
const FLARE_NETWORKS = new Set([
  'flare-coston2', 'flare-songbird', 'flare',
  'eip155:114', 'eip155:19', 'eip155:14',
]);
/** Canonical XRPL CAIP-2 IDs per the T54 / xrpl.org x402 spec. */
const XRPL_NETWORKS = new Set(['xrpl:0', 'xrpl:1', 'xrpl:2']);

/**
 * Detect which payment protocol a 402 response uses based on HTTP headers and challenge body.
 * Reads both the canonical uppercase `PAYMENT-REQUIRED` header (x402 v2 / T54) and the
 * legacy lowercase `payment-required` / `x-payment-required` aliases — the adapter then
 * does the strict re-decode.
 */
export function detectProtocol(
  response: Response,
  preference: ProtocolType = 'auto',
): 'x402' | 'mpp' | 'xrpl' | 'stellar-x402' | 'stellar-mpp' | 'morph-x402' | 'flare-x402' | 'cosmos-msgsend' | 'unknown' {
  const paymentHeader =
    response.headers.get('PAYMENT-REQUIRED') ??
    response.headers.get('payment-required') ??
    response.headers.get('x-payment-required') ??
    '';
  const authHeader = response.headers.get('www-authenticate') ?? '';
  const hasX402 = !!paymentHeader;
  const hasMpp = authHeader.toLowerCase().includes('payment');

  if (hasX402) {
    try {
      const accept = JSON.parse(Buffer.from(paymentHeader, 'base64').toString())?.accepts?.[0];
      // v0.23 — cosmos-msgsend is identified by scheme (not network) since cosmos
      // chains use bare chain-id strings ('interwoven-1') without a stable namespace prefix.
      if (accept?.scheme === 'cosmos-msgsend') return 'cosmos-msgsend';
      const network = accept?.network as string | undefined;
      if (network && XRPL_NETWORKS.has(network)) return 'xrpl';
      if (network && FLARE_NETWORKS.has(network)) return 'flare-x402';
      if (network && MORPH_NETWORKS.has(network)) return 'morph-x402';
      if (network?.startsWith('stellar:')) return 'stellar-x402';
    } catch { /* not base64 JSON — fall through */ }
  }

  if (hasMpp && authHeader.toLowerCase().includes('stellar')) return 'stellar-mpp';

  if (hasX402 && hasMpp) return preference === 'mpp' ? 'mpp' : 'x402';
  if (hasX402) return 'x402';
  if (hasMpp) return 'mpp';
  return 'unknown';
}
