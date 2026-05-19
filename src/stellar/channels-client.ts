import { NPaymentError } from '../errors.js';

/**
 * Stellar x402 facilitator client.
 *
 * Two facilitator backends, one client surface:
 *   - Coinbase x402 (`https://www.x402.org/facilitator`) — testnet, free, sponsored fees, no auth.
 *   - OpenZeppelin Channels (`https://channels.openzeppelin.com/x402[/testnet]`) — mainnet/testnet,
 *     requires Bearer apiKey from https://channels.openzeppelin.com/{,testnet/}gen.
 *
 * Choose Coinbase when no apiKey provided (credential-less default).
 */

// ─── Types (co-located, single file) ────────────────────────────────────────

export interface StellarSupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
}

export interface StellarSupportedResponse {
  kinds: StellarSupportedKind[];
  extensions?: unknown[];
}

export interface StellarVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface StellarSettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
}

export interface StellarChannelsClientConfig {
  /** OZ Channels apiKey. When absent, defaults to Coinbase facilitator (no auth). */
  apiKey?: string;
  /** Override base URL. Default chosen by apiKey presence + isMainnet. */
  baseUrl?: string;
  /** Mainnet (true) or testnet (false). Affects default URL. Default: false. */
  isMainnet?: boolean;
  /** Request timeout ms. Default: 15000. */
  timeoutMs?: number;
}

const COINBASE_FACILITATOR = 'https://www.x402.org/facilitator';
const OZ_CHANNELS_TESTNET = 'https://channels.openzeppelin.com/x402/testnet';
const OZ_CHANNELS_MAINNET = 'https://channels.openzeppelin.com/x402';

export class StellarChannelsClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: StellarChannelsClientConfig = {}) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.baseUrl = (config.baseUrl ?? this.defaultBaseUrl(config.isMainnet ?? false)).replace(/\/$/, '');
  }

  private defaultBaseUrl(isMainnet: boolean): string {
    if (this.apiKey) return isMainnet ? OZ_CHANNELS_MAINNET : OZ_CHANNELS_TESTNET;
    return COINBASE_FACILITATOR;
  }

  /** Public endpoint — no auth required. */
  async getSupported(): Promise<StellarSupportedResponse> {
    return this.request<StellarSupportedResponse>('GET', '/supported');
  }

  /** Verify a signed payment payload without on-chain settlement. */
  async verify(paymentPayload: unknown, paymentRequirements: unknown): Promise<StellarVerifyResponse> {
    return this.request<StellarVerifyResponse>('POST', '/verify', {
      x402Version: 2, paymentPayload, paymentRequirements,
    });
  }

  /** Submit on-chain settlement. */
  async settle(paymentPayload: unknown, paymentRequirements: unknown): Promise<StellarSettleResponse> {
    return this.request<StellarSettleResponse>('POST', '/settle', {
      x402Version: 2, paymentPayload, paymentRequirements,
    });
  }

  private async request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
      if (!res.ok) {
        const reason = String(data.invalidReason ?? data.errorReason ?? res.statusText);
        throw new NPaymentError(
          `Stellar facilitator ${endpoint} failed (${res.status}): ${reason}`,
          this.errorCodeFor(res.status),
          this.errorHintFor(res.status),
        );
      }
      return data;
    } catch (err) {
      if (err instanceof NPaymentError) throw err;
      const msg = (err as Error).name === 'AbortError' ? 'request timed out' : (err as Error).message;
      throw new NPaymentError(`Stellar facilitator ${endpoint} failed: ${msg}`, 'STELLAR_FACILITATOR_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  private errorCodeFor(status: number): string {
    if (status === 401) return 'STELLAR_CHANNELS_AUTH_FAILED';
    if (status === 403) return 'STELLAR_CHANNELS_FORBIDDEN';
    if (status === 429) return 'STELLAR_CHANNELS_RATE_LIMITED';
    return 'STELLAR_FACILITATOR_ERROR';
  }

  private errorHintFor(status: number): string | undefined {
    if (status === 401) return 'Check apiKey from https://channels.openzeppelin.com/gen';
    if (status === 429) return 'Slow down request rate or contact OZ for higher limits';
    return undefined;
  }
}
