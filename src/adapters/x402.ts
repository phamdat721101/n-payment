import type { PaymentAdapter, ChainKey } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { CHAINS } from '../chains.js';
import { InsufficientBalanceError } from '../errors.js';

export class X402Adapter implements PaymentAdapter {
  readonly protocol = 'x402';
  private wallet: OWSWallet;
  private chainKey: ChainKey;

  constructor(wallet: OWSWallet, chainKey: ChainKey) {
    this.wallet = wallet;
    this.chainKey = chainKey;
  }

  detect(response: Response): boolean {
    return response.headers.has('payment-required') || response.headers.has('x-payment-required');
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const chain = CHAINS[this.chainKey];
    const token = chain.tokens.USDC;

    // Parse payment requirements from 402 response
    const body = await response.json().catch(() => ({})) as any;
    const accepts = body.accepts?.[0] ?? {};
    const payTo = accepts.payTo ?? '';
    const amount = BigInt(accepts.maxAmountRequired ?? '10000');

    if (!payTo) throw new InsufficientBalanceError('No payTo address in 402 response', 'MISSING_PAY_TO');

    // Balance pre-check
    const balance = await this.wallet.getBalance(token, chain.chainId);
    if (balance < amount) {
      throw new InsufficientBalanceError(`Insufficient USDC: ${balance} < ${amount}`, 'INSUFFICIENT_BALANCE', 'Fund wallet with USDC');
    }

    const { txHash } = await this.wallet.transferERC20(payTo, token, amount, chain.chainId);

    // Retry with payment proof
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-tx', txHash);
    return fetch(url, { ...init, headers: retryHeaders });
  }
}
