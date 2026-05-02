import type { PaymentAdapter, GoatCredentials } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { GoatX402Client } from '../goat/client.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';

/**
 * GOAT Network x402 adapter with full order lifecycle.
 * Flow: parse 402 → createOrder → OWS-sign ERC-20 → poll → proof → retry
 */
export class GoatAdapter implements PaymentAdapter {
  readonly protocol = 'goat';
  private goatClient: GoatX402Client;
  private wallet: OWSWallet;

  constructor(config: GoatCredentials, wallet: OWSWallet) {
    this.goatClient = new GoatX402Client(config);
    this.wallet = wallet;
  }

  detect(_response: Response): boolean {
    return false; // Selected by chain config, not headers
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const body = await response.json().catch(() => ({})) as any;
    const accepts = body.accepts?.[0] ?? {};
    const chainKey = accepts.network?.includes('48816') ? 'goat-testnet' as const : 'goat-mainnet' as const;
    const chainId = CHAINS[chainKey].chainId;
    const amountWei = accepts.maxAmountRequired ?? '10000';

    const fromAddress = await this.wallet.getAddress(chainId);

    const order = await this.goatClient.createOrder({
      dappOrderId: `npay-${Date.now()}`,
      chainId,
      tokenSymbol: accepts.tokenSymbol ?? 'USDC',
      fromAddress,
      amountWei,
    });

    // ERC-20 transfer(address,uint256) to payToAddress
    const paddedTo = order.payToAddress.slice(2).toLowerCase().padStart(64, '0');
    const paddedAmt = BigInt(amountWei).toString(16).padStart(64, '0');
    const transferData = `0xa9059cbb${paddedTo}${paddedAmt}`;

    const { txHash } = await this.wallet.signTransaction({
      to: CHAINS[chainKey].tokens.USDC ?? order.payToAddress,
      data: transferData,
    }, chainId);

    const finalStatus = await this.goatClient.pollUntilTerminal(order.orderId, 120_000, 2_000);

    if (finalStatus === 'FAILED' || finalStatus === 'EXPIRED' || finalStatus === 'CANCELLED') {
      throw new NPaymentError(`GOAT order ${finalStatus}: ${order.orderId}`, 'GOAT_ORDER_FAILED');
    }

    const proof = await this.goatClient.getOrderProof(order.orderId);

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-proof', JSON.stringify(proof));
    retryHeaders.set('x-payment-tx', txHash);

    return fetch(url, { ...init, headers: retryHeaders });
  }
}
