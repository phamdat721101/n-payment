import type { PaymentAdapter, GoatCredentials, ChainKey } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { GoatX402Client } from '../goat/client.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';
import { BtcLendingVault } from '../goat/lending.js';

/**
 * GOAT Network x402 adapter with full order lifecycle.
 * Flow: parse 402 → createOrder → OWS-sign ERC-20 → poll → proof → retry
 */
export class GoatAdapter implements PaymentAdapter {
  readonly protocol = 'goat';
  private goatClient: GoatX402Client;
  private wallet: OWSWallet;
  private lendingVault?: BtcLendingVault;
  private chainKey: ChainKey;

  constructor(config: GoatCredentials, wallet: OWSWallet, chainKey?: ChainKey, lendingVault?: BtcLendingVault) {
    this.goatClient = new GoatX402Client(config);
    this.wallet = wallet;
    this.chainKey = chainKey ?? (process.env.GOAT_CHAIN === 'mainnet' ? 'goat-mainnet' : 'goat-testnet');
    this.lendingVault = lendingVault;
  }

  detect(_response: Response): boolean {
    return false; // Selected by chain config, not headers
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const body = await response.json().catch(() => ({})) as any;
    const accepts = body.accepts?.[0] ?? {};
    const chainKey = this.chainKey;
    const chainId = CHAINS[chainKey].chainId;
    const amountWei = accepts.maxAmountRequired ?? '10000';

    const fromAddress = await this.wallet.getAddress(chainId);

    let positionTxHash: string | undefined;
    if (this.lendingVault) {
      const collateral = this.lendingVault.estimateCollateral(amountWei);
      positionTxHash = await this.lendingVault.lockAndBorrow(collateral, amountWei, chainId);
    }

    const order = await this.goatClient.createOrder({
      dappOrderId: `npay-${Date.now()}`,
      chainId,
      tokenSymbol: accepts.tokenSymbol ?? 'USDC',
      fromAddress,
      amountWei,
    });

    const { txHash } = await this.wallet.transferERC20(
      order.payToAddress,
      CHAINS[chainKey].tokens.USDC ?? order.payToAddress,
      BigInt(amountWei),
      chainId,
    );

    const finalStatus = await this.goatClient.pollUntilTerminal(order.orderId, 120_000, 2_000);

    if (finalStatus === 'FAILED' || finalStatus === 'EXPIRED' || finalStatus === 'CANCELLED') {
      if (positionTxHash && this.lendingVault) {
        try { await this.lendingVault.repayAndUnlock(positionTxHash, chainId); } catch { /* best-effort */ }
      }
      throw new NPaymentError(`GOAT order ${finalStatus}: ${order.orderId}`, 'GOAT_ORDER_FAILED');
    }

    if (positionTxHash && this.lendingVault) {
      await this.lendingVault.repayAndUnlock(positionTxHash, chainId);
    }

    const proof = await this.goatClient.getOrderProof(order.orderId);

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-proof', JSON.stringify(proof));
    retryHeaders.set('x-payment-tx', txHash);

    return fetch(url, { ...init, headers: retryHeaders });
  }
}
