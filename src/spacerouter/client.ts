/**
 * SpaceRouterClient — high-level orchestrator for the SpaceRouter agentic-bandwidth layer.
 *
 * Composes:
 *   • SpaceRouterSigner          — EIP-712 receipt signing
 *   • SpaceRouterEscrowClient    — on-chain $SPACE escrow lifecycle
 *   • SpaceRouterGatewayClient   — off-chain leg-1 receipt submission
 *   • SpaceRouterReceiptScheduler — auto-batched receipt sync
 *   • @spacenetwork/spacerouter  — wrapped (dynamic import) for proxy CONNECT transport
 *
 * Public API:
 *   const sr = new SpaceRouterClient({ chain, signer, escrowAddress, tokenAddress, ... });
 *   await sr.fetch(url, init?, { region, ipType });
 *   await sr.deposit(parseEther('10'));
 *   await sr.syncReceipts();
 *   await sr.close();
 *
 * Soft credential-less mode: when @spacenetwork/spacerouter peer-dep is missing, fetch() throws
 * a clear NPaymentError with installation hint. Construction does NOT throw — so callers can
 * still use the escrow client standalone for deposits/withdrawals.
 */
import type { Hex, Address, WalletClient } from 'viem';
import type {
  ChainConfig, SpaceRouterRegion, SpaceRouterIpType, SpaceRouterConfig,
} from '../types.js';
import { NPaymentError } from '../errors.js';
import type { SpaceRouterSigner } from './signer.js';
import { SpaceRouterEscrowClient } from './escrow.js';
import {
  SpaceRouterGatewayClient, SpaceRouterReceiptScheduler, type SyncResult,
} from './gateway.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface SpaceRouterClientConfig {
  chain: ChainConfig;
  signer: SpaceRouterSigner;
  escrowAddress: Address;
  tokenAddress: Address;
  /** Required when escrow writes (deposit/withdraw) are needed. */
  privateKey?: Hex;
  /** Provided WalletClient (preferred over privateKey when both set). */
  walletClient?: WalletClient;
  /** Proxy gateway URL (CONNECT). Default: chain.facilitator. */
  gatewayUrl?: string;
  /** Management URL. Default: gatewayUrl + ':8081'. */
  gatewayMgmtUrl?: string;
  apiKey?: string;
  region?: SpaceRouterRegion;
  ipType?: SpaceRouterIpType;
  autoEscrow?: SpaceRouterConfig['autoEscrow'];
  /** TLS verify — set false for self-signed test gateways only. */
  verify?: boolean;
  /** Test override. */
  fetch?: typeof fetch;
}

export interface RoutedResponse {
  response: Response;
  nodeId?: string;
  requestId?: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class SpaceRouterPeerDepMissingError extends NPaymentError {
  constructor() {
    super(
      'Peer dependency @spacenetwork/spacerouter is not installed',
      'SR_PEER_DEP_MISSING',
      'Install with: npm install @spacenetwork/spacerouter (or pnpm/yarn equivalent).',
    );
  }
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class SpaceRouterClient {
  readonly escrow: SpaceRouterEscrowClient;
  readonly gateway: SpaceRouterGatewayClient;
  readonly signer: SpaceRouterSigner;
  readonly scheduler?: SpaceRouterReceiptScheduler;

  private readonly config: SpaceRouterClientConfig;
  private readonly mgmtUrl: string;
  private readonly gatewayUrl: string;
  /** Lazy-loaded @spacenetwork/spacerouter SpaceRouter instance. */
  private wrappedClient: unknown | null = null;
  private wrappedClientLoadErr: Error | null = null;

  constructor(config: SpaceRouterClientConfig) {
    this.config = config;
    this.signer = config.signer;
    this.gatewayUrl = config.gatewayUrl ?? config.chain.facilitator ?? 'https://gateway.spacerouter.org';
    this.mgmtUrl = config.gatewayMgmtUrl ?? deriveMgmtUrl(this.gatewayUrl);

    this.escrow = new SpaceRouterEscrowClient({
      chain: config.chain,
      escrowAddress: config.escrowAddress,
      tokenAddress: config.tokenAddress,
      privateKey: config.privateKey,
      walletClient: config.walletClient,
    });

    this.gateway = new SpaceRouterGatewayClient({
      mgmtUrl: this.mgmtUrl,
      apiKey: config.apiKey,
      fetch: config.fetch,
    });

    if (config.autoEscrow?.claimThreshold || config.autoEscrow?.syncIntervalMs) {
      // Scheduler needs the consumer address — populate lazily on first fetch.
      this.scheduler = undefined; // initialized in `ensureScheduler()` once we have the address
    }
  }

  /** Per-call routing override. Returns a derived client — original is unchanged. */
  withRouting(opts: { region?: SpaceRouterRegion; ipType?: SpaceRouterIpType }): SpaceRouterClient {
    return new SpaceRouterClient({ ...this.config, ...opts });
  }

  /**
   * Send a request through SpaceRouter Proxy. Routes through residential IPs (paying $SPACE
   * leg-1 receipt under the hood). Returns the upstream Response augmented with nodeId/requestId
   * gateway headers when present.
   */
  async fetch(url: string, init?: RequestInit, opts?: { region?: SpaceRouterRegion; ipType?: SpaceRouterIpType }): Promise<Response> {
    await this.ensureBalance();

    const wrapped = await this.loadWrappedClient();
    const region = opts?.region ?? this.config.region;
    const ipType = opts?.ipType ?? this.config.ipType;

    // The official SDK exposes either a high-level `fetch` or `request`. We probe both.
    type WrappedSdk = {
      withRouting?: (opts: { region?: string; ipType?: string }) => WrappedSdk;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
      request?: (method: string, url: string, init?: RequestInit) => Promise<Response>;
    };
    let sdk = wrapped as WrappedSdk;
    if (region || ipType) {
      sdk = sdk.withRouting?.({ region, ipType }) ?? sdk;
    }

    let response: Response;
    if (typeof sdk.fetch === 'function') {
      response = await sdk.fetch(url, init);
    } else if (typeof sdk.request === 'function') {
      response = await sdk.request(init?.method ?? 'GET', url, init);
    } else {
      throw new NPaymentError(
        '@spacenetwork/spacerouter does not expose fetch() or request()',
        'SR_SDK_INTERFACE_UNKNOWN',
        'Pin a compatible @spacenetwork/spacerouter version (>=1.5.0).',
      );
    }

    // Auto-buffer leg-1 receipt when scheduler is configured.
    await this.maybeEnqueueReceipt(response);
    return response;
  }

  /** Convenience: top up escrow. Wraps SpaceRouterEscrowClient.deposit. */
  async deposit(amountWei: bigint): Promise<Hex> {
    return this.escrow.deposit(amountWei);
  }

  /** Manual flush of buffered receipts. */
  async syncReceipts(): Promise<SyncResult | null> {
    return this.scheduler?.flush() ?? null;
  }

  /** Close the scheduler (if any) — flushes pending receipts. Idempotent. */
  async close(): Promise<void> {
    await this.scheduler?.close();
  }

  // ── private ──

  /** Auto-deposit when balance dips below minBalance, if autoEscrow is configured. */
  private async ensureBalance(): Promise<void> {
    const auto = this.config.autoEscrow;
    if (!auto?.minBalance || !auto.topUpAmount) return;
    const consumer = (await this.signer.getAddress()) as Address;
    const balance = await this.escrow.getBalance(consumer);
    if (balance < auto.minBalance) {
      await this.escrow.deposit(auto.topUpAmount);
    }
  }

  private scheduler_lazy?: SpaceRouterReceiptScheduler;
  private async ensureScheduler(): Promise<SpaceRouterReceiptScheduler | undefined> {
    if (!this.config.autoEscrow?.claimThreshold && !this.config.autoEscrow?.syncIntervalMs) return undefined;
    if (this.scheduler_lazy) return this.scheduler_lazy;
    const consumer = await this.signer.getAddress();
    this.scheduler_lazy = new SpaceRouterReceiptScheduler({
      consumer,
      gatewayClient: this.gateway,
      claimThreshold: this.config.autoEscrow.claimThreshold,
      syncIntervalMs: this.config.autoEscrow.syncIntervalMs,
    });
    // Mirror onto readonly handle for advanced consumers.
    (this as { scheduler?: SpaceRouterReceiptScheduler }).scheduler = this.scheduler_lazy;
    return this.scheduler_lazy;
  }

  private async maybeEnqueueReceipt(response: Response): Promise<void> {
    const scheduler = await this.ensureScheduler();
    if (!scheduler) return;
    // The wrapped SDK signs & forwards receipts itself when used via its fetch().
    // We only buffer extra receipts when the gateway returns them in headers.
    const enc = response.headers.get('x-spacerouter-receipt');
    if (!enc) return;
    try {
      const envelope = JSON.parse(Buffer.from(enc, 'base64').toString());
      scheduler.enqueue(envelope);
    } catch {
      // Malformed header from the gateway — skip silently rather than fail the request.
    }
  }

  private async loadWrappedClient(): Promise<unknown> {
    if (this.wrappedClient) return this.wrappedClient;
    if (this.wrappedClientLoadErr) throw this.wrappedClientLoadErr;
    try {
      // Optional peer-dep — dynamic import keeps the core bundle slim.
      const mod = await import('@spacenetwork/spacerouter' as string);
      const SpaceRouterCtor = (mod as { SpaceRouter?: new (...args: unknown[]) => unknown }).SpaceRouter;
      if (!SpaceRouterCtor) throw new Error('SpaceRouter export not found in @spacenetwork/spacerouter');
      const instance = new SpaceRouterCtor(this.config.apiKey ?? 'sr_internal', {
        gatewayUrl: this.gatewayUrl,
        verify: this.config.verify,
        region: this.config.region,
      });
      this.wrappedClient = instance;
      return instance;
    } catch (err) {
      // Distinguish missing peer-dep from other errors. Node ESM says "Cannot find package",
      // Node CJS says "Cannot find module", Vite/esbuild says "Could not resolve". Match any.
      const msg = (err as Error).message ?? '';
      const isMissing =
        msg.includes('@spacenetwork/spacerouter') &&
        (msg.includes('Cannot find package') ||
         msg.includes('Cannot find module') ||
         msg.includes('Could not resolve') ||
         (err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND');
      if (isMissing) {
        this.wrappedClientLoadErr = new SpaceRouterPeerDepMissingError();
        throw this.wrappedClientLoadErr;
      }
      this.wrappedClientLoadErr = err as Error;
      throw err;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveMgmtUrl(gatewayUrl: string): string {
  // Convention: management API is on port 8081 of the same host. If callers explicitly pass a
  // single-port deployment, they should override gatewayMgmtUrl.
  try {
    const u = new URL(gatewayUrl);
    u.port = '8081';
    return u.toString().replace(/\/$/, '');
  } catch {
    return gatewayUrl;
  }
}
