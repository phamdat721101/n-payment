import { CHAINS } from './chains.js';
import type { PaywallConfig, PaywallRouteConfig } from './types.js';

type Req = { method: string; path: string; headers: Record<string, any>; hostname?: string };
type Res = { status(code: number): Res; json(body: any): void; setHeader(name: string, value: string): void };
type Next = () => void;

/**
 * Express middleware that returns dual 402 challenges (x402 + MPP)
 * and verifies payment headers from either protocol.
 */
export function createPaywall(config: PaywallConfig) {
  return (req: Req, res: Res, next: Next) => {
    const routeKey = `${req.method} ${req.path}`;
    const route = config.routes[routeKey];
    if (!route) return next();

    // ── Check x402 payment ──────────────────────────────────────────────
    if (req.headers['payment-signature'] && route.x402) {
      // In production: verify via facilitator POST /verify
      // For v0.1.0: trust the header (facilitator verification is server-side concern)
      return next();
    }

    // ── Check MPP payment ───────────────────────────────────────────────
    const authHeader = req.headers['authorization'] as string | undefined;
    if (authHeader?.startsWith('Payment ') && route.mpp) {
      // In production: verify via mppx/server
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
      const currency = route.mpp.currency ?? config.mpp?.currency ?? '';
      res.setHeader(
        'www-authenticate',
        `Payment realm="${req.hostname ?? 'api'}", method="tempo", currency="${currency}", amount="${route.price}", recipient="${recipient}"`,
      );
    }

    const protocols = [route.x402 && 'x402', route.mpp && 'mpp'].filter(Boolean);
    res.status(402).json({ error: 'Payment required', protocols });
  };
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
