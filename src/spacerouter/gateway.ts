/**
 * SpaceRouterGatewayClient — talks to the gateway management API (port 8081).
 * Endpoints used:
 *   GET  /auth/challenge?consumer=0x...   → { challenge, gateway, expiresAt, priceWeiPerGB }
 *   POST /leg1/submit                     → { accepted: boolean }
 *   POST /leg1/sync                       → { accepted: string[], rejected: string[], pending_count: number }
 *
 * SpaceRouterReceiptScheduler — buffers signed receipts and flushes them on:
 *   • request-count threshold (claimThreshold)
 *   • time interval (syncIntervalMs)
 *   • close()
 * Mirrors the autoSettleThreshold semantics of v0.8 BatchSettlementManager.
 */
import type { Hex, Address } from 'viem';
import type {
  SpaceRouterReceipt, SpaceRouterSigner,
} from './signer.js';
import { spaceRouterDomain } from './signer.js';
import { NPaymentError } from '../errors.js';

// ─── Wire types ─────────────────────────────────────────────────────────────

export interface GatewayChallenge {
  challenge: Hex;            // opaque blob the gateway will replay
  gateway: Address;          // gateway address (used as `gateway` field in receipt)
  requestUuid: Hex;          // bytes16 request ID (server-allocated)
  expiresAt: number;         // unix seconds
  priceWeiPerGB: string;     // bigint as string
  bytesEstimate: number;     // gateway's expected byte count for this request
}

export interface SignedReceiptEnvelope {
  receipt: {
    consumer: Hex;
    gateway: Address;
    requestUuid: Hex;
    bytesServed: string;     // bigint as string (JSON-safe)
    priceWei: string;
    expiresAt: string;
  };
  signature: Hex;
}

export interface SyncResult {
  accepted: string[];
  rejected: string[];
  pendingCount: number;
}

// ─── Gateway client ─────────────────────────────────────────────────────────

export interface GatewayClientConfig {
  /** Management URL, e.g. https://gateway.spacerouter.org:8081 */
  mgmtUrl: string;
  /** Optional API key (sr_live_...). */
  apiKey?: string;
  /** Test override. */
  fetch?: typeof fetch;
  /** Default timeout in ms. */
  timeoutMs?: number;
}

export class SpaceRouterGatewayClient {
  private readonly mgmtUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: GatewayClientConfig) {
    this.mgmtUrl = config.mgmtUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /** Fetch a per-request EIP-712 challenge for the consumer. */
  async requestChallenge(consumer: Hex): Promise<GatewayChallenge> {
    const data = await this.request<GatewayChallenge>('GET', `/auth/challenge?consumer=${consumer}`);
    return data;
  }

  /** Submit a single signed receipt synchronously. */
  async submitReceipt(envelope: SignedReceiptEnvelope): Promise<{ accepted: boolean }> {
    return this.request<{ accepted: boolean }>('POST', '/leg1/submit', envelope);
  }

  /** Batch-sync all unsubmitted receipts for `consumer`. */
  async syncReceipts(consumer: Hex, envelopes: SignedReceiptEnvelope[]): Promise<SyncResult> {
    const data = await this.request<{ accepted: string[]; rejected: string[]; pending_count: number }>(
      'POST', '/leg1/sync', { consumer, receipts: envelopes },
    );
    return { accepted: data.accepted, rejected: data.rejected, pendingCount: data.pending_count };
  }

  /**
   * Build + sign a receipt from a challenge. Pure helper — does not mutate or persist.
   */
  static async buildReceipt(
    signer: SpaceRouterSigner,
    chainId: number,
    escrowContract: Address,
    challenge: GatewayChallenge,
    bytesServed: bigint,
    priceWei: bigint,
  ): Promise<SignedReceiptEnvelope> {
    const consumer = await signer.getAddress();
    const receipt: SpaceRouterReceipt = {
      consumer,
      gateway: challenge.gateway,
      requestUuid: challenge.requestUuid,
      bytesServed,
      priceWei,
      expiresAt: BigInt(challenge.expiresAt),
    };
    const signature = await signer.signReceipt(spaceRouterDomain(chainId, escrowContract), receipt);
    return {
      receipt: {
        consumer,
        gateway: receipt.gateway,
        requestUuid: receipt.requestUuid,
        bytesServed: receipt.bytesServed.toString(),
        priceWei: receipt.priceWei.toString(),
        expiresAt: receipt.expiresAt.toString(),
      },
      signature,
    };
  }

  // ── private ──
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.mgmtUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
      if (!res.ok) {
        throw new NPaymentError(
          `SpaceRouter gateway ${path} failed (${res.status}): ${String(data.error ?? res.statusText)}`,
          this.errorCodeFor(res.status),
          this.errorHintFor(res.status),
        );
      }
      return data;
    } catch (err) {
      if (err instanceof NPaymentError) throw err;
      const msg = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new NPaymentError(`SpaceRouter gateway ${path} failed: ${msg}`, 'SR_GATEWAY_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  private errorCodeFor(status: number): string {
    if (status === 402) return 'SR_ESCROW_EMPTY';
    if (status === 407) return 'SR_AUTH_FAILED';
    if (status === 429) return 'SR_RATE_LIMITED';
    if (status === 503) return 'SR_NO_PROVIDERS';
    if (status === 502 || status === 504) return 'SR_PROVIDER_UNREACHABLE';
    return 'SR_GATEWAY_ERROR';
  }
  private errorHintFor(status: number): string | undefined {
    if (status === 402) return 'Top up SPACE escrow: client.deposit(parseSpace("1")).';
    if (status === 407) return 'Check API key / EIP-712 signature; ensure receipt headers are on the proxy CONNECT, not the inner request.';
    if (status === 429) return 'Rate-limited by the gateway. Back off and retry, or raise autoEscrow.syncIntervalMs to flush less aggressively.';
    if (status === 503) return 'No provider matches your region/ipType filter — relax filters with client.withRouting({}) or retry later.';
    if (status === 502 || status === 504) return 'Provider unreachable mid-request. Retry once; if persistent, check the SpaceRouter status page.';
    return undefined;
  }
}

// ─── Receipt scheduler ──────────────────────────────────────────────────────

export interface ReceiptSchedulerConfig {
  consumer: Hex;
  gatewayClient: SpaceRouterGatewayClient;
  /** Sync after this many buffered receipts. */
  claimThreshold?: number;
  /** Sync every N ms. */
  syncIntervalMs?: number;
  /** Optional event hooks for analytics/audit. */
  onSync?: (result: SyncResult) => void;
  onError?: (err: Error) => void;
}

/**
 * Buffers signed receipts and flushes them on threshold/interval/close. Idempotent close().
 */
export class SpaceRouterReceiptScheduler {
  private readonly buffer: SignedReceiptEnvelope[] = [];
  private readonly config: ReceiptSchedulerConfig;
  private timer?: ReturnType<typeof setInterval>;
  private flushing = false;
  private closed = false;

  constructor(config: ReceiptSchedulerConfig) {
    this.config = config;
    if (config.syncIntervalMs && config.syncIntervalMs > 0) {
      this.timer = setInterval(() => { void this.flush(); }, config.syncIntervalMs);
      // Don't keep the Node event loop alive just for this timer.
      this.timer.unref?.();
    }
  }

  /** Enqueue a signed receipt. Flushes when claimThreshold is hit. */
  enqueue(envelope: SignedReceiptEnvelope): void {
    if (this.closed) throw new NPaymentError('Scheduler is closed', 'SR_SCHEDULER_CLOSED');
    this.buffer.push(envelope);
    if (this.config.claimThreshold && this.buffer.length >= this.config.claimThreshold) {
      void this.flush();
    }
  }

  /** Flush all buffered receipts to the gateway. Safe to call concurrently — no-op if already flushing. */
  async flush(): Promise<SyncResult | null> {
    if (this.flushing || this.buffer.length === 0) return null;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      const result = await this.config.gatewayClient.syncReceipts(this.config.consumer, batch);
      this.config.onSync?.(result);
      return result;
    } catch (err) {
      // Push the batch back so a future flush retries it.
      this.buffer.unshift(...batch);
      this.config.onError?.(err as Error);
      return null;
    } finally {
      this.flushing = false;
    }
  }

  pendingCount(): number { return this.buffer.length; }

  /** Stop the timer and flush any remaining receipts. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
