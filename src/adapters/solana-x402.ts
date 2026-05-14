import type { PaymentAdapter } from '../types.js';
import { NPaymentError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SolanaX402Config {
  rpcUrl?: string;
  keypair?: string; // Base58 secret key
  facilitator?: string;
}

// ─── Solana x402 Adapter ───────────────────────────────────────────────────────

export class SolanaX402Adapter implements PaymentAdapter {
  readonly protocol = 'x402-solana';
  private config: SolanaX402Config;

  constructor(config: SolanaX402Config = {}) {
    this.config = {
      rpcUrl: config.rpcUrl ?? 'https://api.mainnet-beta.solana.com',
      facilitator: config.facilitator ?? 'https://api.cdp.coinbase.com/platform/v2/x402',
      ...config,
    };
  }

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? '';
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const network = decoded.accepts?.[0]?.network ?? '';
      return network.startsWith('solana:');
    } catch {
      return false;
    }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const header = response.headers.get('payment-required') ?? '';
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    const accepts = decoded.accepts?.[0] ?? {};

    if (!this.config.keypair) {
      throw new NPaymentError('Solana keypair required for x402 payments', 'SOLANA_NO_KEYPAIR');
    }

    // SPL token transfer for payment
    const txSignature = await this.transferSPL({
      to: accepts.payTo,
      amount: BigInt(accepts.maxAmountRequired ?? '0'),
      mint: accepts.asset,
    });

    // Retry with payment proof
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-tx', txSignature);
    retryHeaders.set('x-payment-network', accepts.network);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  private async transferSPL(params: { to: string; amount: bigint; mint: string }): Promise<string> {
    // Placeholder — real impl uses @solana/web3.js + @solana/spl-token
    // 1. Create associated token accounts if needed
    // 2. Build transfer instruction
    // 3. Sign with keypair
    // 4. Send and confirm transaction
    throw new NPaymentError(
      'Solana SPL transfer requires @solana/web3.js — install as peer dependency',
      'SOLANA_NOT_CONFIGURED',
      'npm install @solana/web3.js @solana/spl-token',
    );
  }
}
