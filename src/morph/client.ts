import { signMorphRequest } from './auth.js';
import { NPaymentError } from '../errors.js';

/**
 * Morph x402 Facilitator REST client.
 *
 * Endpoints (https://morph-rails.morph.network/x402):
 *   GET  /v2/supported  — public, returns supported networks/schemes
 *   POST /v2/verify     — HMAC, verify a payment payload (no on-chain side effect)
 *   POST /v2/settle     — HMAC, submit on-chain settlement
 *
 * Compatible with Coinbase x402 SDK request/response schemas.
 */

// ─── Response Types (co-located to keep file count minimal) ─────────────────

export interface MorphSupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
}

export interface MorphSupportedResponse {
  kinds: MorphSupportedKind[];
  extensions?: unknown[];
  signers?: Record<string, string[]>;
}

export interface MorphVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface MorphSettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
}

export interface MorphX402ClientConfig {
  accessKey?: string;
  secretKey?: string;
  /** Override base URL. Default: https://morph-rails.morph.network/x402 (mainnet). */
  baseUrl?: string;
  /** Timeout for facilitator requests in ms. Default: 15000. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://morph-rails.morph.network/x402';
const PATH_PREFIX = '/x402';

export class MorphX402Client {
  private readonly accessKey?: string;
  private readonly secretKey?: string;
  private readonly origin: string;
  private readonly timeoutMs: number;

  constructor(config: MorphX402ClientConfig = {}) {
    this.accessKey = config.accessKey;
    this.secretKey = config.secretKey;
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    // Allow callers to pass either ".../x402" or "..." — normalize to origin only.
    this.origin = base.endsWith(PATH_PREFIX) ? base.slice(0, -PATH_PREFIX.length) : base;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /** GET /v2/supported — public endpoint, no auth required. */
  async getSupported(): Promise<MorphSupportedResponse> {
    return this.request<MorphSupportedResponse>('GET', '/v2/supported');
  }

  /** POST /v2/verify — verify a payment payload without settling on-chain. */
  async verify(
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ): Promise<MorphVerifyResponse> {
    return this.request<MorphVerifyResponse>('POST', '/v2/verify', {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
  }

  /** POST /v2/settle — submit on-chain settlement. */
  async settle(
    paymentPayload: unknown,
    paymentRequirements: unknown,
  ): Promise<MorphSettleResponse> {
    return this.request<MorphSettleResponse>('POST', '/v2/settle', {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
  }

  /** Single request path: handles auth, timeout, error mapping. */
  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const fullPath = `${PATH_PREFIX}${endpoint}`;
    const url = `${this.origin}${fullPath}`;
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const needsAuth = endpoint !== '/v2/supported';

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (needsAuth) {
      if (!this.accessKey || !this.secretKey) {
        throw new NPaymentError(
          `Morph ${endpoint} requires accessKey and secretKey`,
          'MORPH_NO_CREDENTIALS',
          'Register at https://morph-rails.morph.network/x402 to obtain credentials',
        );
      }
      Object.assign(
        headers,
        signMorphRequest({
          method,
          path: fullPath,
          body: bodyStr,
          accessKey: this.accessKey,
          secretKey: this.secretKey,
        }),
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
      if (!res.ok) {
        const reason = String(data.invalidReason ?? data.errorReason ?? res.statusText);
        throw new NPaymentError(
          `Morph facilitator ${endpoint} failed (${res.status}): ${reason}`,
          this.errorCodeFor(res.status),
          this.errorHintFor(res.status),
        );
      }
      return data;
    } catch (err) {
      if (err instanceof NPaymentError) throw err;
      const msg = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new NPaymentError(`Morph facilitator ${endpoint} failed: ${msg}`, 'MORPH_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  private errorCodeFor(status: number): string {
    if (status === 401) return 'MORPH_AUTH_FAILED';
    if (status === 403) return 'MORPH_KEY_DISABLED';
    if (status === 429) return 'MORPH_RATE_LIMITED';
    return 'MORPH_FACILITATOR_ERROR';
  }

  private errorHintFor(status: number): string | undefined {
    if (status === 401) return 'Verify HMAC signing: timestamp ms, sorted JSON, full path with /x402 prefix';
    if (status === 429) return 'Default 10 QPS per Access Key — slow down or contact Morph for higher limits';
    return undefined;
  }
}
