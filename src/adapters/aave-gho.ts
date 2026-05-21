import type { PaymentAdapter, PaymentContext } from '../types.js';
import { GHO_ADDRESSES } from '../aave/client.js';

const GHO_ADDR_SET = new Set(Object.values(GHO_ADDRESSES).map(a => a.toLowerCase()));

/**
 * PaymentAdapter that detects and pays with GHO when servers accept it.
 * Delegates actual signing to the PaymentClient's wallet + GhoManager.
 */
export class AaveGhoAdapter implements PaymentAdapter {
  readonly protocol = 'aave-gho';

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') || response.headers.get('x-payment');
    if (!header) return false;
    // Check if any accepted asset is GHO
    const lower = header.toLowerCase();
    for (const addr of GHO_ADDR_SET) {
      if (lower.includes(addr)) return true;
    }
    return false;
  }

  async pay(url: string, init: RequestInit | undefined, response: Response, ctx?: PaymentContext): Promise<Response> {
    // This adapter is wired by PaymentClient which handles:
    // 1. GhoManager.buildPermitTypedData() → wallet.signTypedData()
    // 2. Encode permit signature into x402 payment payload
    // 3. Retry request with PAYMENT-SIGNATURE header
    // The actual implementation is in PaymentClient.fetchWithPayment() Aave path.
    throw new Error('AaveGhoAdapter.pay() should be called via PaymentClient Aave integration');
  }
}
