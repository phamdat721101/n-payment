import { CHAINS } from './chains.js';
import type { PaywallConfig, PaywallRouteConfig } from './types.js';
import { buildFlareX402Challenge, decodeFlareX402Header, verifyAndSettleFlareX402 } from './flare/x402.js';
import type { Address, PublicClient, WalletClient } from 'viem';

type Req = { method: string; path: string; headers: Record<string, any>; hostname?: string };
type Res = { status(code: number): Res; json(body: any): void; setHeader(name: string, value: string): void };
type Next = () => void;

/**
 * v0.19: Optional Flare merchant settle deps. Inject via the second arg to
 * createPaywall when any route has `flare: {…}`. Kept off the PaywallConfig
 * surface to avoid forcing viem on consumers who do not use Flare.
 */
export interface FlareMerchantDeps {
  publicClient: PublicClient;
  walletClient: WalletClient;
}

/**
 * Express middleware that returns dual 402 challenges (x402 + MPP)
 * and verifies payment headers from either protocol.
 *
 * When mppx is installed, uses mppx/server for proper MPP credential verification.
 * Otherwise falls back to header-presence check.
 */
export function createPaywall(config: PaywallConfig, flareDeps?: FlareMerchantDeps) {
  return (req: Req, res: Res, next: Next) => {
    const routeKey = `${req.method} ${req.path}`;
    const route = config.routes[routeKey];
    if (!route) return next();

    // ── v0.19: Flare x402 (on-chain X402Facilitator) — handle first because the
    //          buyer header is `x-payment`, which is *also* used by other rails. ─
    if (route.flare) {
      const xPayment = req.headers['x-payment'] as string | undefined;
      if (xPayment) {
        if (!flareDeps) {
          res.status(500).json({ error: 'Flare merchant deps missing — pass flareDeps to createPaywall' });
          return;
        }
        const payload = (() => {
          try { return decodeFlareX402Header(xPayment); }
          catch (err) { res.status(402).json({ error: (err as Error).message }); return null; }
        })();
        if (!payload) return;
        if (BigInt(payload.value) < BigInt(route.price)) {
          res.status(402).json({ error: 'Insufficient payment', required: route.price, received: payload.value });
          return;
        }
        verifyAndSettleFlareX402({
          publicClient: flareDeps.publicClient,
          walletClient: flareDeps.walletClient,
          facilitatorAddress: route.flare.facilitatorAddress as Address,
          payload,
        })
          .then((settle) => {
            res.setHeader(
              'x-payment-response',
              Buffer.from(
                JSON.stringify({
                  paymentId: settle.paymentId,
                  transactionHash: settle.transactionHash,
                  settled: true,
                }),
              ).toString('base64'),
            );
            next();
          })
          .catch((err: Error) => {
            res.status(402).json({ error: 'Flare verification/settlement failed', message: err.message });
          });
        return;
      }
      // No payment yet — render Flare-flavoured 402 challenge.
      const flareCfg = route.flare;
      const challenge = buildFlareX402Challenge({
        price: route.price,
        payTo: flareCfg.payTo,
        asset: flareCfg.asset,
        facilitatorAddress: flareCfg.facilitatorAddress,
        network: flareCfg.network,
        chainId: flareCfg.chainId,
        resource: req.path,
        description: route.description,
      });
      res.setHeader('payment-required', challenge);
      res.status(402).json({ error: 'Payment required', protocols: ['flare-x402'] });
      return;
    }

    // ── Check x402 payment ──────────────────────────────────────────────
    if ((req.headers['payment-signature'] || req.headers['x-payment-tx']) && route.x402) {
      // Verify payment via facilitator if configured
      const facilitatorUrl = route.x402.facilitator ?? config.facilitator;
      if (facilitatorUrl) {
        verifyX402Payment(facilitatorUrl, req.headers, route).then((valid) => {
          if (valid) return next();
          res.status(402).json({ error: 'Payment verification failed' });
        }).catch(() => {
          res.status(402).json({ error: 'Payment verification unavailable' });
        });
        return;
      }
      // No facilitator configured — pass through (dev mode)
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

    // ── Check Morph payment (x402-compatible, identified by Morph CAIP-2) ─
    const paymentNetwork = req.headers['x-payment-network'];
    if (req.headers['x-payment-tx'] && route.morph &&
        (paymentNetwork === 'eip155:2818' || paymentNetwork === 'eip155:2910')) {
      return next();
    }

    // ── No payment — return 402 with BOTH challenges ────────────────────
    if (route.x402 && !route.morph) {
      const network = route.x402.network ?? 'eip155:84532';
      const asset = route.x402.asset ?? CHAINS['base-sepolia'].tokens.USDC;
      const challenge = Buffer.from(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network, maxAmountRequired: route.price, asset, payTo: route.x402.payTo }],
      })).toString('base64');
      res.setHeader('payment-required', challenge);
    }

    if (route.morph) {
      const network = route.morph.network ?? 'eip155:2818';
      const asset = route.morph.asset ?? CHAINS['morph-mainnet'].tokens.USDC;
      const scheme = route.morph.scheme ?? 'exact';
      const challenge = Buffer.from(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme, network, maxAmountRequired: route.price, asset, payTo: route.morph.payTo }],
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

    const protocols = [route.x402 && !route.morph && 'x402', route.mpp && 'mpp', route.xrpl && 'xrpl', route.morph && 'morph-x402'].filter(Boolean);
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
      protocols: [cfg.x402 && !cfg.morph && 'x402', cfg.mpp && 'mpp', cfg.morph && 'morph-x402'].filter(Boolean),
    }));
    res.status(200).json({ status: 'ok', routes });
  };
}

/** Verify x402 payment signature via facilitator /verify endpoint. */
async function verifyX402Payment(
  facilitatorUrl: string,
  headers: Record<string, any>,
  route: PaywallRouteConfig,
): Promise<boolean> {
  try {
    const res = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentSignature: headers['payment-signature'],
        paymentTx: headers['x-payment-tx'],
        payTo: route.x402?.payTo,
        maxAmountRequired: route.price,
        network: route.x402?.network ?? 'eip155:84532',
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── v0.22 — RLUSD self-verification (PRD-D Primitive A & B) ────────────────

/** ERC-20 Transfer event topic0: keccak256('Transfer(address,address,uint256)'). */
const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS_TOPIC =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Idempotency: in-memory cache of consumed tx hashes. Replace with Redis / SQLite for prod. */
const idempotencyCache = new Set<string>();

/** Decode an indexed-address topic to a lowercased 0x... string. */
function decodeAddressTopic(topic: string): string {
  return ('0x' + topic.slice(-40)).toLowerCase();
}

/**
 * Decode the X-PAYMENT base64 envelope into a strictly-typed payload.
 * Returns null if shape is invalid — callers respond with 402.
 */
export function decodeRlusdExactPayment(headerVal: string): {
  scheme: 'exact';
  network: string;
  txHash: string;
  from: string;
  to: string;
  value: string;
  asset: string;
} | null {
  try {
    const decoded = JSON.parse(Buffer.from(headerVal, 'base64').toString());
    if (decoded.scheme !== 'exact' || typeof decoded.txHash !== 'string') return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Self-verify a `scheme: 'exact'` RLUSD payment via on-chain Transfer log.
 * No facilitator dependency. Caller passes a viem-shape PublicClient that
 * supports getTransactionReceipt + getBlockNumber.
 *
 * SOLID — DIP: depends on a minimal viem-style interface, not the concrete
 * viem package, so callers can inject ethers/etherjs/web3.js shims.
 */
export interface RlusdRpcClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{
    status: 'success' | 'reverted' | number;
    blockNumber: bigint;
    logs: Array<{ address: string; topics: readonly string[]; data: string }>;
  } | null>;
  getBlockNumber(): Promise<bigint>;
}

export interface VerifyRlusdExactInput {
  headerVal: string;
  expectedAsset: `0x${string}`;
  expectedTo: `0x${string}`;
  expectedMinValue: bigint;
  rpc: RlusdRpcClient;
  /** Max block age allowed for replay protection. Default 1000. */
  maxBlockAge?: bigint;
}

export type VerifyRlusdResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: string };

export async function verifyExactRlusdPayment(
  input: VerifyRlusdExactInput,
): Promise<VerifyRlusdResult> {
  const payload = decodeRlusdExactPayment(input.headerVal);
  if (!payload) return { ok: false, reason: 'invalid-header' };

  const txHash = payload.txHash as `0x${string}`;
  if (idempotencyCache.has(txHash)) return { ok: false, reason: 'tx-already-consumed' };

  const receipt = await input.rpc.getTransactionReceipt({ hash: txHash });
  if (!receipt) return { ok: false, reason: 'tx-not-confirmed' };
  const status = receipt.status;
  const ok = status === 'success' || status === 1;
  if (!ok) return { ok: false, reason: 'tx-reverted' };

  // Recency: tx must be in last N blocks (replay window protection).
  const tip = await input.rpc.getBlockNumber();
  const ageLimit = input.maxBlockAge ?? 1000n;
  if (tip - receipt.blockNumber > ageLimit) return { ok: false, reason: 'tx-too-old' };

  // Match: ERC-20 Transfer(from=<any>, to=expectedTo, value≥expectedMinValue) on expectedAsset.
  const transferLog = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === input.expectedAsset.toLowerCase() &&
      l.topics[0] === ERC20_TRANSFER_TOPIC &&
      l.topics.length === 3 &&
      decodeAddressTopic(l.topics[2]!) === input.expectedTo.toLowerCase() &&
      BigInt(l.data) >= input.expectedMinValue,
  );
  if (!transferLog) return { ok: false, reason: 'transfer-log-missing-or-mismatch' };

  idempotencyCache.add(txHash);
  return { ok: true, txHash };
}

/**
 * Self-verify a `wormhole-ntt-transfer` payment by reading the dest-chain mint
 * event (PRD-D Primitive B). The NTT redemption mint to the merchant IS the proof.
 */
export interface VerifyWormholeNttInput {
  headerVal: string;
  /** RLUSD ERC-20 on the destination chain. */
  expectedAsset: `0x${string}`;
  expectedTo: `0x${string}`;
  expectedMinValue: bigint;
  rpc: RlusdRpcClient;
  maxBlockAge?: bigint;
}

export async function verifyWormholeNttPayment(
  input: VerifyWormholeNttInput,
): Promise<VerifyRlusdResult> {
  let payload: { scheme: string; destTxHash?: string; destNetwork?: string };
  try {
    payload = JSON.parse(Buffer.from(input.headerVal, 'base64').toString());
  } catch {
    return { ok: false, reason: 'invalid-header' };
  }
  if (payload.scheme !== 'wormhole-ntt-transfer' || !payload.destTxHash) {
    return { ok: false, reason: 'wrong-scheme-or-missing-dest-tx' };
  }
  const destTxHash = payload.destTxHash as `0x${string}`;
  if (idempotencyCache.has(destTxHash)) return { ok: false, reason: 'tx-already-consumed' };

  const receipt = await input.rpc.getTransactionReceipt({ hash: destTxHash });
  if (!receipt) return { ok: false, reason: 'dest-tx-not-confirmed' };
  const ok = receipt.status === 'success' || receipt.status === 1;
  if (!ok) return { ok: false, reason: 'dest-tx-reverted' };

  const tip = await input.rpc.getBlockNumber();
  const ageLimit = input.maxBlockAge ?? 1000n;
  if (tip - receipt.blockNumber > ageLimit) return { ok: false, reason: 'tx-too-old' };

  // NTT redemption: ERC-20 Transfer(from=0x0, to=merchant, value≥expectedMinValue) — i.e. mint.
  const mintLog = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === input.expectedAsset.toLowerCase() &&
      l.topics[0] === ERC20_TRANSFER_TOPIC &&
      l.topics.length === 3 &&
      l.topics[1] === ZERO_ADDRESS_TOPIC &&
      decodeAddressTopic(l.topics[2]!) === input.expectedTo.toLowerCase() &&
      BigInt(l.data) >= input.expectedMinValue,
  );
  if (!mintLog) return { ok: false, reason: 'redemption-log-missing-or-mismatch' };

  idempotencyCache.add(destTxHash);
  return { ok: true, txHash: destTxHash };
}

/** Test-only utility — clears the in-memory idempotency cache between vitest runs. */
export function _clearRlusdIdempotencyCache(): void {
  idempotencyCache.clear();
}
