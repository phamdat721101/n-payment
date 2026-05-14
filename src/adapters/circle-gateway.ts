import type { PaymentAdapter } from '../types.js';
import { NPaymentError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CircleGatewayConfig {
  apiKey: string;
  environment?: 'sandbox' | 'production';
  walletId?: string;
}

// ─── Circle Gateway Adapter ────────────────────────────────────────────────────

export class CircleGatewayAdapter implements PaymentAdapter {
  readonly protocol = 'nanopayment';
  private config: CircleGatewayConfig;
  private baseUrl: string;

  constructor(config: CircleGatewayConfig) {
    this.config = config;
    this.baseUrl = config.environment === 'production'
      ? 'https://gateway.circle.com'
      : 'https://gateway-sandbox.circle.com';
  }

  detect(response: Response): boolean {
    // Circle nanopayments use x402 with Circle facilitator
    const header = response.headers.get('payment-required') ?? '';
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      return decoded.accepts?.[0]?.facilitator?.includes('circle') ?? false;
    } catch {
      return false;
    }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const header = response.headers.get('payment-required') ?? '';
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    const accepts = decoded.accepts?.[0] ?? {};

    // Sign EIP-3009 authorization offchain (gas-free via Circle Gateway)
    const authorization = await this.signAuthorization({
      payTo: accepts.payTo,
      amount: BigInt(accepts.maxAmountRequired ?? '0'),
      token: accepts.asset,
    });

    // Retry with signed authorization
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-authorization', JSON.stringify(authorization));
    retryHeaders.set('x-payment-gateway', 'circle');
    return fetch(url, { ...init, headers: retryHeaders });
  }

  /** Get unified balance across chains */
  async getBalance(): Promise<{ available: string; currency: string }> {
    const res = await fetch(`${this.baseUrl}/v1/wallets/${this.config.walletId}/balance`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (!res.ok) throw new NPaymentError('Failed to get Circle balance', 'CIRCLE_BALANCE_ERROR');
    return res.json() as any;
  }

  private async signAuthorization(params: { payTo: string; amount: bigint; token: string }) {
    // EIP-3009 transferWithAuthorization — offchain signature
    return {
      from: this.config.walletId ?? '',
      to: params.payTo,
      value: params.amount.toString(),
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: `0x${Date.now().toString(16)}`,
      // Real impl: sign with Circle wallet key
      signature: `0x${'0'.repeat(130)}`,
    };
  }
}
