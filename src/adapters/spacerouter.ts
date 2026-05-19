/**
 * SpaceRouterAdapter — implements ProxyAdapter.
 *
 * Wraps SpaceRouterClient so PaymentClient can route requests through it the same way
 * it routes payments through PaymentAdapter implementations.
 *
 * Smart-fallback detection: shouldFallback(response) returns true on classic data-center-IP
 * blocks (Cloudflare 1010/1020, 403/429 with cf-ray header, generic 503).
 */
import type { ProxyAdapter, PaymentContext } from '../types.js';
import type { SpaceRouterClient } from '../spacerouter/client.js';

export class SpaceRouterAdapter implements ProxyAdapter {
  readonly protocol = 'spacerouter';

  constructor(private readonly client: SpaceRouterClient) {}

  detect(ctx: PaymentContext | undefined, response?: Response): boolean {
    if (ctx?.proxy === 'spacerouter') return true;
    if (ctx?.proxy === 'auto' && response && SpaceRouterAdapter.shouldFallback(response)) return true;
    return false;
  }

  async route(url: string, init: RequestInit | undefined, ctx?: PaymentContext): Promise<Response> {
    return this.client.fetch(url, init, { region: ctx?.region, ipType: ctx?.ipType });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Heuristic: would routing through a residential proxy likely unblock this response?
   * Static so PaymentClient can call it without holding an adapter instance.
   */
  static shouldFallback(response: Response): boolean {
    const status = response.status;
    const hasCfRay = response.headers.has('cf-ray');
    if (status === 403 && hasCfRay) return true;       // Cloudflare bot-block
    if (status === 429 && hasCfRay) return true;       // Cloudflare rate-limit
    if (status === 503 && hasCfRay) return true;       // Cloudflare-driven 503
    if (status === 451) return true;                   // legal blocking — geo-route may help
    // Some sites surface explicit Cloudflare error codes in the body; we read up to 8KB only.
    return false;
  }
}
