import { owsExec } from './exec.js';
import { NPaymentError } from '../errors.js';
import type { OWSConfig, OWSSignResult } from './types.js';

export interface TransactionRequest {
  to: string;
  value?: string;
  data?: string;
}

export class OWSWallet {
  private wallet: string;
  private cliPath: string;

  constructor(config: OWSConfig) {
    this.wallet = config.wallet;
    this.cliPath = config.cliPath ?? 'ows';
  }

  async getAddress(chainId: number): Promise<string> {
    const result = await owsExec(this.cliPath, [
      'fund', 'balance', '--wallet', this.wallet, '--chain', String(chainId),
    ]);
    if (!result.ok) {
      throw new NPaymentError(result.error ?? 'Failed to get address', result.code ?? 'OWS_ERROR', result.hint);
    }
    const data = result.data as any;
    return typeof data === 'object' ? data.address : String(data).match(/0x[a-fA-F0-9]{40}/)?.[0] ?? '';
  }

  async signTransaction(tx: TransactionRequest, chainId: number): Promise<OWSSignResult> {
    const txJson = JSON.stringify({ to: tx.to, value: tx.value, data: tx.data, type: 2 });
    const result = await owsExec(this.cliPath, [
      'sign', 'tx', '--wallet', this.wallet, '--chain', String(chainId), '--tx', txJson,
    ]);
    if (!result.ok) {
      throw new NPaymentError(result.error ?? 'Sign failed', result.code ?? 'OWS_ERROR', result.hint);
    }
    const data = result.data as any;
    const signedTx = typeof data === 'object' ? data.signedTx : String(data);
    const txHash = typeof data === 'object' ? data.txHash : signedTx.match(/0x[a-fA-F0-9]{64}/)?.[0] ?? '';
    return { signedTx, txHash };
  }

  async signMessage(message: string): Promise<string> {
    const result = await owsExec(this.cliPath, [
      'sign', 'message', '--wallet', this.wallet, '--message', message,
    ]);
    if (!result.ok) {
      throw new NPaymentError(result.error ?? 'Sign message failed', result.code ?? 'OWS_ERROR', result.hint);
    }
    return String((result.data as any)?.signature ?? result.data);
  }

  async payX402(url: string, method = 'GET'): Promise<string> {
    const args = ['pay', 'request', '--wallet', this.wallet, '--url', url];
    if (method !== 'GET') args.push('--method', method);
    const result = await owsExec(this.cliPath, args);
    if (!result.ok) {
      throw new NPaymentError(result.error ?? 'Payment failed', result.code ?? 'PAYMENT_FAILED', result.hint);
    }
    return JSON.stringify(result.data);
  }

  get walletName(): string { return this.wallet; }
}
