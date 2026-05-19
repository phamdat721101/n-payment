import type { NPaymentConfig, PaymentAdapter, PaymentContext } from './types.js';
import { CHAINS, getChainsForProtocol } from './chains.js';
import { createConfig } from './config.js';
import { detectProtocol } from './detect.js';
import { AdapterNotFoundError } from './errors.js';
import { AnalyticsEmitter } from './analytics.js';
import { OWSWallet } from './ows/wallet.js';
import { X402Adapter } from './adapters/x402.js';
import { MppAdapter } from './adapters/mpp.js';
import { GoatAdapter } from './adapters/goat.js';
import { XrplAdapter } from './adapters/xrpl.js';
import { XrplWallet } from './xrpl/wallet.js';
import { StellarX402Adapter } from './adapters/stellar-x402.js';
import { StellarMppAdapter } from './adapters/stellar-mpp.js';
import { StellarWallet } from './stellar/wallet.js';
import { BtcLendingVault } from './goat/lending.js';
import { CircleGatewayAdapter } from './adapters/circle-gateway.js';
import { SolanaX402Adapter } from './adapters/solana-x402.js';
import { MorphX402Adapter } from './adapters/morph-x402.js';
import { MorphX402Client } from './morph/client.js';
import { PolicyEngine, AuditLog, SpendingGuard } from './policy/index.js';

export class PaymentClient {
  private adapters: PaymentAdapter[] = [];
  private analytics: AnalyticsEmitter;
  private config: NPaymentConfig;
  private guard?: SpendingGuard;
  readonly wallet: OWSWallet;

  constructor(config: NPaymentConfig) {
    this.config = createConfig(config);
    this.analytics = new AnalyticsEmitter(config.analytics?.plugins);
    this.wallet = new OWSWallet(config.ows);

    // Policy engine (v0.8)
    if (config.policy) {
      const engine = PolicyEngine.fromConfig(config.policy);
      this.guard = new SpendingGuard(engine, new AuditLog());
    }

    const proto = this.config.protocol ?? 'auto';
    const hasX402 = getChainsForProtocol(config.chains, 'x402').length > 0;
    const hasMpp = getChainsForProtocol(config.chains, 'mpp').length > 0;
    const hasGoat = getChainsForProtocol(config.chains, 'goat').length > 0;

    if (hasX402 && proto !== 'mpp') {
      const x402Chain = getChainsForProtocol(config.chains, 'x402')[0];
      this.adapters.push(new X402Adapter(this.wallet, x402Chain));
    }
    if (hasMpp && proto !== 'x402') {
      const mppChain = getChainsForProtocol(config.chains, 'mpp')[0];
      this.adapters.push(new MppAdapter(this.wallet, mppChain, config.autoFaucet));
    }
    if (hasGoat && config.goat) {
      const goatChain = getChainsForProtocol(config.chains, 'goat')[0];
      const vault = config.btcLending ? new BtcLendingVault(this.wallet, config.btcLending) : undefined;
      this.adapters.push(new GoatAdapter(config.goat, this.wallet, goatChain, vault));
    }

    const hasXrpl = getChainsForProtocol(config.chains, 'xrpl').length > 0;
    if (hasXrpl && config.xrpl?.seed) {
      const xrplChain = getChainsForProtocol(config.chains, 'xrpl')[0];
      const xrplWallet = new XrplWallet({ seed: config.xrpl.seed, owsWallet: config.ows.wallet });
      this.adapters.push(new XrplAdapter(xrplWallet, xrplChain));
    }

    const hasStellarX402 = getChainsForProtocol(config.chains, 'stellar-x402').length > 0;
    const hasStellarMpp = getChainsForProtocol(config.chains, 'stellar-mpp').length > 0;
    if ((hasStellarX402 || hasStellarMpp) && config.stellar?.secretKey) {
      const stellarWallet = new StellarWallet({ secretKey: config.stellar.secretKey });
      const stellarChain = getChainsForProtocol(config.chains, 'stellar-x402')[0] ?? getChainsForProtocol(config.chains, 'stellar-mpp')[0];
      if (hasStellarX402) this.adapters.push(new StellarX402Adapter(stellarWallet, stellarChain));
      if (hasStellarMpp) this.adapters.push(new StellarMppAdapter(stellarWallet, stellarChain));
    }

    // Circle Gateway nanopayments (v0.8)
    if (config.circle) {
      this.adapters.push(new CircleGatewayAdapter(config.circle));
    }

    // Solana x402 (v0.8)
    if (config.solana) {
      this.adapters.push(new SolanaX402Adapter(config.solana));
    }

    // Morph x402 (v0.9) — soft credential-less mode: warn-and-skip when keys missing
    const hasMorph = getChainsForProtocol(config.chains, 'morph-x402').length > 0;
    if (hasMorph) {
      const morphChain = getChainsForProtocol(config.chains, 'morph-x402')[0];
      const morphCfg = config.morph;
      const hasCreds = !!(morphCfg?.accessKey && morphCfg?.secretKey);
      if (hasCreds) {
        const morphClient = new MorphX402Client({
          accessKey: morphCfg!.accessKey,
          secretKey: morphCfg!.secretKey,
          baseUrl: morphCfg!.facilitatorUrl ?? CHAINS[morphChain].facilitator,
        });
        this.adapters.push(new MorphX402Adapter(this.wallet, morphClient, morphChain));
      } else if (morphCfg?.strict) {
        throw new AdapterNotFoundError(
          'Morph chain configured with strict mode but accessKey/secretKey missing',
          'MORPH_NO_CREDENTIALS',
          'Register at https://morph-rails.morph.network/x402 to obtain credentials',
        );
      } else {
        console.warn(
          '[n-payment] Morph chain configured without accessKey/secretKey — Morph adapter disabled. ' +
          'Register at https://morph-rails.morph.network/x402 to enable.',
        );
      }
    }
  }

  async fetchWithPayment(url: string, init?: RequestInit, opts?: PaymentContext): Promise<Response> {
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

    const chain = this.config.chains[0];

    // Policy check (v0.8) — referenceKey/metadata flow into audit
    if (this.guard) {
      const decision = this.guard.check({
        url, amount: 0n, chain,
        referenceKey: opts?.referenceKey, metadata: opts?.metadata,
      });
      if (!decision.allowed) {
        throw new AdapterNotFoundError(`Policy denied: ${decision.reason}`, 'POLICY_DENIED');
      }
    }

    try {
      const result = await adapter.pay(url, init, response, opts);
      if (this.guard) this.guard.recordPayment({
        url, amount: 0n, chain,
        referenceKey: opts?.referenceKey, metadata: opts?.metadata,
      });
      this.analytics.emit({
        protocol: adapter.protocol, chain, url,
        success: true, durationMs: Date.now() - start, timestamp: Date.now(),
      });
      return result;
    } catch (err) {
      this.analytics.emit({
        protocol: adapter.protocol, chain, url,
        success: false, durationMs: Date.now() - start, timestamp: Date.now(),
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /** Get the spending guard for audit access */
  getGuard(): SpendingGuard | undefined {
    return this.guard;
  }
}

export function createPaymentClient(config: NPaymentConfig): PaymentClient {
  return new PaymentClient(config);
}
