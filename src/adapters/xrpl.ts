import type { PaymentAdapter, ChainKey } from '../types.js';
import { XrplWallet } from '../xrpl/wallet.js';
import { XrplConnection } from '../xrpl/connection.js';
import { ensureTrustLine, sendRLUSD } from '../xrpl/payments.js';
import { NPaymentError } from '../errors.js';

export class XrplAdapter implements PaymentAdapter {
  readonly protocol = 'xrpl';
  private wallet: XrplWallet;
  private connection: XrplConnection;

  constructor(wallet: XrplWallet, chainKey: ChainKey) {
    this.wallet = wallet;
    this.connection = new XrplConnection(chainKey);
  }

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? '';
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      return decoded.accepts?.[0]?.network?.startsWith('xrpl:') ?? false;
    } catch {
      return false;
    }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const header = response.headers.get('payment-required') ?? '';
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    const accepts = decoded.accepts?.[0] ?? {};
    const payTo = accepts.payTo;
    const amount = accepts.maxAmountRequired ?? '1';

    if (!payTo) throw new NPaymentError('No payTo in XRPL payment challenge', 'XRPL_MISSING_PAY_TO');

    await ensureTrustLine(this.connection, this.wallet);
    const { hash } = await sendRLUSD(this.connection, this.wallet, payTo, amount);

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-tx', hash);
    retryHeaders.set('x-payment-network', 'xrpl');
    return fetch(url, { ...init, headers: retryHeaders });
  }

  async disconnect(): Promise<void> {
    await this.connection.disconnect();
  }
}
