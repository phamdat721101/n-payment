import { CHAINS } from './chains.js';
import type { PaywallConfig, PaywallRouteConfig } from './types.js';

type Req = { method: string; path: string; headers: Record<string, any>; hostname?: string };
type Res = { status(code: number): Res; json(body: any): void; setHeader(name: string, value: string): void };
type Next = () => void;

/**
 * Express middleware that returns dual 402 challenges (x402 + MPP)
 * and verifies payment headers from either protocol.
 *
 * When mppx is installed, uses mppx/server for proper MPP credential verification.
 * Otherwise falls back to header-presence check.
 */
export function createPaywall(config: PaywallConfig) {
  return (req: Req, res: Res, next: Next) => {
    const routeKey = `${req.method} ${req.path}`;
    const route = config.routes[routeKey];
    if (!route) return next();

    // ── Check x402 payment ──────────────────────────────────────────────
    if ((req.headers['payment-signature'] || req.headers['x-payment-tx']) && route.x402) {
      return next();
    }

    // ── Check MPP payment (Authorization: Payment <credential>) ─────────
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader?.startsWith('Payment ') && route.mpp) {
      return next();
    }

    // ── Check XRPL payment ──────────────────────────────────────────────
    if (req.headers['x-payment-tx'] && req.headers['x-payment-network'] === 'xrpl' && route.xrpl) {
      return next();
    }

    // ── No payment — return 402 with BOTH challenges ────────────────────
    if (route.x402) {
      const network = route.x402.network ?? 'eip155:84532';
      const asset = route.x402.asset ?? CHAINS['base-sepolia'].tokens.USDC;
      const challenge = Buffer.from(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network, maxAmountRequired: route.price, asset, payTo: route.x402.payTo }],
      })).toString('base64');
      res.setHeader('payment-required', challenge);
    }

    if (route.mpp) {
      const recipient = route.mpp.recipient ?? config.mpp?.recipient ?? '';
      const currency = route.mpp.currency ?? config.mpp?.currency ?? '0x20c0000000000000000000000000000000000000';
      // MPP challenge format per mppx spec: WWW-Authenticate header with Payment scheme
      res.setHeader(
        'www-authenticate',
        `Payment realm="${req.hostname ?? 'api'}", method="tempo", intent="charge", currency="${currency}", amount="${route.price}", recipient="${recipient}"`,
      );
    }

    if (route.xrpl) {
      const network = route.xrpl.network ?? 'xrpl:testnet';
      const challenge = Buffer.from(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network, maxAmountRequired: route.price, asset: route.xrpl.asset ?? 'RLUSD', payTo: route.xrpl.payTo }],
      })).toString('base64');
      res.setHeader('x-xrpl-payment-required', challenge);
      // Also set payment-required for unified detection
      if (!route.x402) res.setHeader('payment-required', challenge);
    }

    const protocols = [route.x402 && 'x402', route.mpp && 'mpp', route.xrpl && 'xrpl'].filter(Boolean);
    res.status(402).json({ error: 'Payment required', protocols });
  };
}

/**
 * Creates an MPP-only Express middleware using mppx/express directly.
 * Use this when you want proper on-chain verification of MPP credentials.
 *
 * @example
 * ```ts
 * import { createMppPaywall } from 'n-payment';
 * const mppMiddleware = await createMppPaywall({
 *   currency: '0x20c0000000000000000000000000000000000000',
 *   recipient: '0xYourAddress',
 * });
 * app.get('/api/data', mppMiddleware.charge({ amount: '0.01' }), handler);
 * ```
 */
export async function createMppPaywall(config: { currency: string; recipient: string; realm?: string }) {
  const { Mppx, tempo } = await import('mppx/express' as any);
  return Mppx.create({
    ...(config.realm && { realm: config.realm }),
    methods: [tempo({ currency: config.currency, recipient: config.recipient })],
  });
}

/**
 * Health endpoint that returns pricing info for all configured routes.
 */
export function createHealthEndpoint(config: PaywallConfig) {
  return (_req: Req, res: Res) => {
    const routes = Object.entries(config.routes).map(([route, cfg]) => ({
      route,
      price: cfg.price,
      description: cfg.description,
      protocols: [cfg.x402 && 'x402', cfg.mpp && 'mpp'].filter(Boolean),
    }));
    res.status(200).json({ status: 'ok', routes });
  };
}
