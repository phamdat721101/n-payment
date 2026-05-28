import type { NPaymentConfig, PaymentAdapter, PaymentContext, ProxyAdapter } from './types.js';
import { CHAINS, getChainsForProtocol } from './chains.js';
import { createConfig } from './config.js';
import { detectProtocol } from './detect.js';
import { AdapterNotFoundError, NPaymentError } from './errors.js';
import { AnalyticsEmitter } from './analytics.js';
import { OWSWallet } from './ows/wallet.js';
import { X402Adapter } from './adapters/x402.js';
import { MppAdapter } from './adapters/mpp.js';
import { GoatAdapter } from './adapters/goat.js';
import { XrplAdapter } from './adapters/xrpl.js';
import { XrplConnection } from './xrpl/connection.js';
import { XrplWallet } from './xrpl/wallet.js';
import { XrplVaultClient } from './xrpl/vault.js';
import { XrplSwapClient } from './xrpl/swap.js';
import { XrplTreasuryManager } from './xrpl/treasury.js';
import { getRlusdIssuer, networkFromChainKey } from './xrpl/utils.js';
import { StellarX402Adapter } from './adapters/stellar-x402.js';
import { StellarMppAdapter } from './adapters/stellar-mpp.js';
import { StellarWallet } from './stellar/wallet.js';
import { KeypairStellarSigner } from './stellar/signer.js';
import { StellarChannelsClient } from './stellar/channels-client.js';
import { StellarSessionClient, type StellarSessionClientConfig } from './stellar/session.js';
import { BtcLendingVault } from './goat/lending.js';
import { UsdcAcquisitionRouter } from './goat/acquisition.js';
import { CircleGatewayAdapter } from './adapters/circle-gateway.js';
import { SolanaX402Adapter } from './adapters/solana-x402.js';
import { MorphX402Adapter } from './adapters/morph-x402.js';
import { MorphX402Client } from './morph/client.js';
import { PolicyEngine, AuditLog, SpendingGuard } from './policy/index.js';
import { SpaceRouterAdapter } from './adapters/spacerouter.js';
import { SpaceRouterClient } from './spacerouter/client.js';
import { OWSSpaceRouterSigner, KeypairSpaceRouterSigner } from './spacerouter/signer.js';
import { AaveTreasuryManager } from './aave/index.js';
import { AaveGhoAdapter } from './adapters/aave-gho.js';
import type { Hex, Address } from 'viem';

const SPACE_ROUTER_DEFAULTS = {
  'creditcoin-mainnet': {
    escrow: '0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0',
    token: '0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9',
  },
  'creditcoin-testnet': {
    // TBD — published with v1.5 testnet release. Override via spacerouter.escrowContract / tokenAddress.
    escrow: '0x0000000000000000000000000000000000000000',
    token: '0x0000000000000000000000000000000000000000',
  },
} as const;

export class PaymentClient {
  private adapters: PaymentAdapter[] = [];
  private proxyAdapters: ProxyAdapter[] = [];
  private analytics: AnalyticsEmitter;
  private config: NPaymentConfig;
  private guard?: SpendingGuard;
  readonly wallet: OWSWallet;
  readonly aave?: AaveTreasuryManager;
  /** v0.14: XRPL XLS-65 vault treasury (yield-parity). Constructed when xrpl.treasury.autoYield is set. */
  readonly xrplTreasury?: XrplTreasuryManager;

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
      let router: UsdcAcquisitionRouter | undefined;
      if (config.goat.autoFund?.enabled) {
        router = new UsdcAcquisitionRouter({
          goatChain,
          wallet: this.wallet,
          config: config.goat.autoFund,
          partnerChains: config.chains.filter((c) => c.endsWith('-mainnet') || c.endsWith('-sepolia')),
          bridgeUrl: config.goat.bridgeUrl,
          btcSigner: config.goat.btcSigner,
          usdcOverride: config.goat.usdcOverride,
          dexOverride: config.goat.dexOverride,
          guard: this.guard,
        });
        router.validateConfig();
      }
      this.adapters.push(new GoatAdapter(config.goat, this.wallet, goatChain, vault, router));
    }

    const hasXrpl = getChainsForProtocol(config.chains, 'xrpl').length > 0;
    if (hasXrpl) {
      const xrplChain = getChainsForProtocol(config.chains, 'xrpl')[0];
      const xrplCfg = config.xrpl;
      const hasCreds = !!(xrplCfg?.seed || config.ows.wallet);
      if (hasCreds) {
        const network = networkFromChainKey(xrplChain);
        const issuer = getRlusdIssuer(network);
        const xrplWallet = new XrplWallet({ seed: xrplCfg?.seed, owsWallet: config.ows.wallet });
        const xrplConn = new XrplConnection(xrplCfg?.server ?? xrplChain);
        const xrplVault = new XrplVaultClient(xrplConn, xrplWallet, issuer);
        const xrplSwap = new XrplSwapClient(xrplConn, xrplWallet, network, issuer);

        let treasury: XrplTreasuryManager | undefined;
        if (xrplCfg?.treasury?.autoYield) {
          treasury = new XrplTreasuryManager(
            { ...xrplCfg.treasury, minXrpReserve: xrplCfg.minXrpReserve },
            { connection: xrplConn, wallet: xrplWallet, vault: xrplVault, network },
          );
          this.xrplTreasury = treasury;
        }

        this.adapters.push(
          new XrplAdapter(xrplWallet, xrplConn, network, xrplSwap, treasury, {
            autoSwap: xrplCfg?.autoSwap,
            maxSlippageBps: xrplCfg?.maxSlippageBps,
          }),
        );
      } else if (xrplCfg?.strict) {
        throw new AdapterNotFoundError(
          'XRPL chain configured with strict mode but xrpl.seed / ows.wallet missing',
          'XRPL_NO_CREDENTIALS',
          'Provide xrpl: { seed: "sEd..." } or use OWS wallet identity, or set strict: false for credential-less dev.',
        );
      } else {
        console.warn(
          '[n-payment] XRPL chain configured without xrpl.seed / ows.wallet — XRPL adapter disabled. ' +
          'Provide xrpl.seed or use OWS to enable, or pass xrpl.strict: true to fail fast.',
        );
      }
    }

    // Stellar v0.10 — soft credential-less mode (mirrors Morph pattern)
    const hasStellarX402 = getChainsForProtocol(config.chains, 'stellar-x402').length > 0;
    const hasStellarMpp = getChainsForProtocol(config.chains, 'stellar-mpp').length > 0;
    if (hasStellarX402 || hasStellarMpp) {
      const stellarChain = getChainsForProtocol(config.chains, 'stellar-x402')[0] ?? getChainsForProtocol(config.chains, 'stellar-mpp')[0];
      const stellarCfg = config.stellar;
      if (stellarCfg?.secretKey) {
        const isMainnet = stellarChain === 'stellar-mainnet';
        // Lazy signer init via promise — adapters await getAddressAsync internally
        const signer = new KeypairStellarSigner(stellarCfg.secretKey, stellarCfg.publicKey);
        // Resolve address eagerly so adapter has it ready (fire-and-forget; failures throw on first use)
        void KeypairStellarSigner.fromSecret(stellarCfg.secretKey).then((s) => {
          (signer as { address: string }).address = s.address;
        }).catch(() => {/* deferred to first sign call */});
        const channelsClient = new StellarChannelsClient({
          apiKey: stellarCfg.channelsApiKey,
          baseUrl: stellarCfg.facilitatorUrl,
          isMainnet,
        });
        if (hasStellarX402) this.adapters.push(new StellarX402Adapter(signer, stellarChain, channelsClient, stellarCfg.rpcUrl));
        if (hasStellarMpp) this.adapters.push(new StellarMppAdapter(signer, stellarChain));
      } else if (stellarCfg?.strict) {
        throw new AdapterNotFoundError(
          'Stellar chain configured with strict mode but stellar.secretKey missing',
          'STELLAR_NO_SECRET',
          'Provide stellar: { secretKey: "S..." } or set strict: false for credential-less dev',
        );
      } else {
        console.warn(
          '[n-payment] Stellar chain configured without stellar.secretKey — Stellar adapters disabled. ' +
          'Pass stellar: { secretKey: "S..." } or use FreighterStellarSigner directly in browser.',
        );
      }
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

    // SpaceRouter (v0.11) — soft mode: warn-and-skip when peer-dep / config missing
    const hasSpaceRouter = getChainsForProtocol(config.chains, 'spacerouter').length > 0;
    if (hasSpaceRouter) {
      const srChainKey = getChainsForProtocol(config.chains, 'spacerouter')[0];
      const srChain = CHAINS[srChainKey];
      const srCfg = config.spacerouter;
      const defaults = SPACE_ROUTER_DEFAULTS[srChainKey as keyof typeof SPACE_ROUTER_DEFAULTS];
      const escrowAddress = (srCfg?.escrowContract ?? defaults?.escrow) as Address | undefined;
      const tokenAddress = (srCfg?.tokenAddress ?? defaults?.token ?? srChain.tokens.SPACE ?? srChain.tokens.SPC) as Address | undefined;
      if (!escrowAddress || !tokenAddress) {
        if (srCfg?.strict) {
          throw new AdapterNotFoundError(
            'SpaceRouter requires escrowContract and tokenAddress',
            'SR_INVALID_CONFIG',
            'Pass spacerouter.escrowContract and spacerouter.tokenAddress.',
          );
        }
        console.warn('[n-payment] SpaceRouter chain configured without escrow/token addresses — adapter disabled.');
      } else {
        const privateKey = config.ows?.privateKey as Hex | undefined;
        const signer = privateKey
          ? new KeypairSpaceRouterSigner(privateKey)
          : new OWSSpaceRouterSigner(this.wallet, srChain.chainId);
        const srClient = new SpaceRouterClient({
          chain: srChain,
          signer,
          escrowAddress,
          tokenAddress,
          privateKey,
          gatewayUrl: srCfg?.gatewayUrl ?? srChain.facilitator,
          gatewayMgmtUrl: srCfg?.gatewayMgmtUrl,
          apiKey: srCfg?.apiKey,
          region: srCfg?.region,
          ipType: srCfg?.ipType,
          autoEscrow: srCfg?.autoEscrow,
          verify: srCfg?.verify,
        });
        this.proxyAdapters.push(new SpaceRouterAdapter(srClient));
      }
    }

    // Aave Treasury (v0.13) — yield-bearing agent wallet + GHO payments
    if (config.aave) {
      const aaveChain = config.chains.find(c => ['base-mainnet', 'ethereum'].includes(c)) ?? config.chains[0];
      this.aave = new AaveTreasuryManager(config.aave, aaveChain);
      if (config.aave.preferGho) {
        this.adapters.push(new AaveGhoAdapter());
      }
    }
  }

  async fetchWithPayment(url: string, init?: RequestInit, opts?: PaymentContext): Promise<Response> {
    const start = Date.now();
    const ctx = opts ?? {};
    const chain = this.config.chains[0];

    // Up-front policy check (pre-payment, amount unknown yet — uses 0n for rate/region checks only)
    if (this.guard) {
      const decision = this.guard.check({
        url, amount: 0n, chain,
        referenceKey: ctx.referenceKey, metadata: ctx.metadata,
        region: ctx.region, ipType: ctx.ipType,
      });
      if (!decision.allowed) {
        throw new AdapterNotFoundError(`Policy denied: ${decision.reason}`, 'POLICY_DENIED');
      }
    }

    // ── Step 1: initial fetch — direct or via explicit proxy ──
    let proxyUsed: ProxyAdapter | undefined;
    let response: Response;

    if (ctx.proxy === 'spacerouter') {
      proxyUsed = this.proxyAdapters.find((p) => p.protocol === 'spacerouter');
      if (!proxyUsed) {
        throw new AdapterNotFoundError(
          'No spacerouter adapter configured', 'NO_PROXY_ADAPTER',
          'Add a creditcoin-* chain and spacerouter config to NPaymentConfig.',
        );
      }
      response = await proxyUsed.route(url, init, ctx);
    } else {
      response = await fetch(url, init);

      // ── Step 1b: smart fallback on 403/429/Cloudflare-block ──
      if (ctx.proxy === 'auto' && this.proxyAdapters.length) {
        const fallback = this.proxyAdapters.find((p) => p.detect(ctx, response));
        if (fallback) {
          response = await fallback.route(url, init, ctx);
          proxyUsed = fallback;
        }
      }
    }

    // Audit-log bandwidth use whenever a proxy hop happened.
    if (proxyUsed && this.guard) {
      this.guard.recordBandwidth({
        url, amount: 0n, chain,
        region: ctx.region, ipType: ctx.ipType,
        referenceKey: ctx.referenceKey, metadata: ctx.metadata,
      });
      this.analytics.emit({
        protocol: proxyUsed.protocol, chain, url,
        success: true, durationMs: Date.now() - start, timestamp: Date.now(),
      });
    }

    // ── Step 2: not a paywall — return as-is ──
    if (response.status !== 402) return response;

    // ── Step 3: 402 paywall — find payment adapter + settle ──
    const protocol = detectProtocol(response, this.config.protocol);

    // Validate facilitator against trusted allowlist (if configured)
    if (this.config.policy?.trustedFacilitators?.length) {
      const facilitator = this.extractFacilitator(response);
      if (facilitator && !this.config.policy.trustedFacilitators.includes(facilitator)) {
        throw new NPaymentError(
          `Untrusted facilitator: ${facilitator}`,
          'UNTRUSTED_FACILITATOR',
        );
      }
    }

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
      const result = await adapter.pay(url, init, response, opts);

      // Extract real amount from the 402 challenge for accurate policy tracking
      const challengeAmount = this.extractChallengeAmount(response);
      if (this.guard) {
        // Post-payment policy check with real amount (cap enforcement)
        const maxCap = this.config.policy?.maxPerTransaction ?? 100_000_000n; // default $100 cap
        if (challengeAmount > maxCap) {
          throw new NPaymentError(
            `Challenge amount ${challengeAmount} exceeds max cap ${maxCap}`,
            'AMOUNT_CAP_EXCEEDED',
          );
        }
        this.guard.recordPayment({
          url, amount: challengeAmount, chain,
          referenceKey: ctx.referenceKey, metadata: ctx.metadata,
        });
      }
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

  /** Graceful shutdown — flushes any open proxy adapter resources (e.g. SpaceRouter receipts). */
  async close(): Promise<void> {
    for (const p of this.proxyAdapters) {
      if (p.close) await p.close();
    }
  }

  /**
   * Create an MPP Session client for high-frequency off-chain micropayments via the
   * one-way-channel Soroban contract. Channel must already be deployed and pre-funded.
   */
  createStellarSession(config: StellarSessionClientConfig): StellarSessionClient {
    return new StellarSessionClient(config);
  }

  /** Extract payment amount from a 402 challenge response (best-effort). */
  private extractChallengeAmount(response: Response): bigint {
    try {
      const header = response.headers.get('payment-required') ?? '';
      if (!header) return 0n;
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const amount = decoded.accepts?.[0]?.maxAmountRequired;
      return amount ? BigInt(amount) : 0n;
    } catch {
      return 0n;
    }
  }

  /** Extract facilitator URL from a 402 challenge (best-effort). */
  private extractFacilitator(response: Response): string | undefined {
    try {
      const header = response.headers.get('payment-required') ?? '';
      if (!header) return undefined;
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      return decoded.accepts?.[0]?.facilitator ?? undefined;
    } catch {
      return undefined;
    }
  }
}

export function createPaymentClient(config: NPaymentConfig): PaymentClient {
  return new PaymentClient(config);
}
