import type { NPaymentConfig, PaymentAdapter } from './types.js';
import { getChainsForProtocol } from './chains.js';
import { createConfig } from './config.js';
import { detectProtocol } from './detect.js';
import { AdapterNotFoundError } from './errors.js';
import { AnalyticsEmitter } from './analytics.js';
import { OWSWallet } from './ows/wallet.js';
import { X402Adapter } from './adapters/x402.js';
import { MppAdapter } from './adapters/mpp.js';
import { GoatAdapter } from './adapters/goat.js';

export class PaymentClient {
  private adapters: PaymentAdapter[] = [];
  private analytics: AnalyticsEmitter;
  private config: NPaymentConfig;
  readonly wallet: OWSWallet;

  constructor(config: NPaymentConfig) {
    this.config = createConfig(config);
    this.analytics = new AnalyticsEmitter(config.analytics?.plugins);
    this.wallet = new OWSWallet(config.ows);

    const proto = this.config.protocol ?? 'auto';
    const hasX402 = getChainsForProtocol(config.chains, 'x402').length > 0;
    const hasMpp = getChainsForProtocol(config.chains, 'mpp').length > 0;
    const hasGoat = getChainsForProtocol(config.chains, 'goat').length > 0;

    if (hasX402 && proto !== 'mpp') this.adapters.push(new X402Adapter(this.wallet));
    if (hasMpp && proto !== 'x402') this.adapters.push(new MppAdapter(this.wallet));
    if (hasGoat && config.goat) this.adapters.push(new GoatAdapter(config.goat, this.wallet));
  }

  async fetchWithPayment(url: string, init?: RequestInit): Promise<Response> {
    const start = Date.now();
    const response = await fetch(url, init);
    if (response.status !== 402) return response;

    const protocol = detectProtocol(response, this.config.protocol);
    const adapter =
      this.adapters.find((a) => a.protocol === protocol) ??
      this.adapters.find((a) => a.detect(response));

    if (!adapter) {
      throw new AdapterNotFoundError(
        `No adapter for protocol: ${protocol}`, 'NO_ADAPTER',
        `Configured chains: ${this.config.chains.join(', ')}`,
      );
    }

    try {
      const result = await adapter.pay(url, init, response);
      this.analytics.emit({
        protocol: adapter.protocol, chain: this.config.chains[0], url,
        success: true, durationMs: Date.now() - start, timestamp: Date.now(),
      });
      return result;
    } catch (err) {
      this.analytics.emit({
        protocol: adapter.protocol, chain: this.config.chains[0], url,
        success: false, durationMs: Date.now() - start, timestamp: Date.now(),
        error: (err as Error).message,
      });
      throw err;
    }
  }
}

export function createPaymentClient(config: NPaymentConfig): PaymentClient {
  return new PaymentClient(config);
}
