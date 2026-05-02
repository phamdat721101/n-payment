import type { PaymentAdapter } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';

/**
 * x402 adapter — uses OWS `pay request` for the full 402→sign→retry cycle.
 */
export class X402Adapter implements PaymentAdapter {
  readonly protocol = 'x402';
  private wallet: OWSWallet;

  constructor(wallet: OWSWallet) {
    this.wallet = wallet;
  }

  detect(response: Response): boolean {
    return (
      response.headers.has('payment-required') ||
      response.headers.has('x-payment-required')
    );
  }

  async pay(url: string, init: RequestInit | undefined, _response: Response): Promise<Response> {
    const method = init?.method ?? 'GET';
    // OWS handles the full 402→sign→retry cycle
    const responseBody = await this.wallet.payX402(url, method);
    return new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
}
