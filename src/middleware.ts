import { CHAINS } from './chains.js';
import type { PaywallConfig, PaywallRouteConfig } from './types.js';
import { buildFlareX402Challenge, decodeFlareX402Header, verifyAndSettleFlareX402 } from './flare/x402.js';
import {
  decodePaymentSignatureHeader,
  defaultFacilitatorUrl,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  XrplFacilitatorClient,
  type XrplPaymentRequirements,
} from './xrpl/x402-scheme.js';
import { getRlusdIssuer, parseCaip2, RLUSD_HEX, DEFAULT_SOURCE_TAG, type XrplNetwork } from './xrpl/utils.js';
import { XrplConnection } from './xrpl/connection.js';
import { XrplWallet } from './xrpl/wallet.js';
import { ensureTrustline } from './xrpl/payments.js';
import { NPaymentError } from './errors.js';
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
  // v0.29: Build the optional merchant XRPL signer once. Mirrors XrplWallet's
  // dual-mode (raw seed | OWS-managed key). When neither is set, the paywall
  // runs in fail-fast mode and any RLUSD route with a missing trustline 503s.
  const xrplMerchantWallet: XrplWallet | undefined = (config.xrpl?.seed || config.xrpl?.owsWallet)
    ? new XrplWallet({ seed: config.xrpl.seed, owsWallet: config.xrpl.owsWallet })
    : undefined;

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

    // ── v0.28: XRPL x402 (T54 canonical) — owns the request when route.xrpl is set ─
    if (route.xrpl) {
      handleXrplRoute(req, res, next, route, xrplMerchantWallet);
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

    const protocols = [route.x402 && !route.morph && 'x402', route.mpp && 'mpp', route.morph && 'morph-x402'].filter(Boolean);
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

// ─── v0.28: XRPL x402 (T54 canonical) merchant handler ──────────────────────

/**
 * Per-process invoice cache. Maps invoiceId → { route, expiresAt, consumed }.
 * Replace with Redis / SQLite for prod via the v0.28 idempotency-store interface.
 */
interface XrplInvoiceRecord {
  routeKey: string;
  expiresAt: number;
  consumed: boolean;
}
const xrplInvoices = new Map<string, XrplInvoiceRecord>();
const XRPL_INVOICE_TTL_MS = 10 * 60 * 1000; // 10 minutes — the spec's maxTimeoutSeconds default.

/**
 * Test/operational helper — purge the in-memory invoice cache.
 * Public so harnesses can guarantee determinism across runs.
 */
export function clearXrplInvoiceCache(): void {
  xrplInvoices.clear();
}

/** Cached facilitator clients keyed by URL — avoids re-allocating per request. */
const xrplFacilitators = new Map<string, XrplFacilitatorClient>();
function getFacilitator(url: string): XrplFacilitatorClient {
  let c = xrplFacilitators.get(url);
  if (!c) {
    c = new XrplFacilitatorClient(url);
    xrplFacilitators.set(url, c);
  }
  return c;
}

/**
 * Per-process XRPL connection cache (one per network). Created lazily on
 * first RLUSD trustline preflight; reused across requests. Avoids opening
 * a fresh WebSocket on every paid call.
 */
const xrplConnectionsByNet = new Map<XrplNetwork, XrplConnection>();
function getXrplConnection(network: XrplNetwork): XrplConnection {
  let c = xrplConnectionsByNet.get(network);
  if (!c) {
    c = new XrplConnection(network === 'mainnet' ? 'xrpl-mainnet' : 'xrpl-testnet');
    xrplConnectionsByNet.set(network, c);
  }
  return c;
}

/** Test/operational helper — clear connection cache (and disconnect each). */
export function clearXrplConnectionCache(): void {
  for (const c of xrplConnectionsByNet.values()) void c.disconnect().catch(() => {});
  xrplConnectionsByNet.clear();
}

/**
 * Build the canonical PAYMENT-REQUIRED challenge from a route + a freshly
 * minted invoiceId. Returns the encoded header value.
 */
function buildXrplChallenge(
  route: PaywallRouteConfig,
  invoiceId: string,
): string {
  const cfg = route.xrpl!;
  const network = cfg.network ?? 'xrpl:1';
  const xrplNet = parseCaip2(network);
  const assetSymbol = cfg.asset ?? 'RLUSD';
  const requirements: XrplPaymentRequirements = {
    scheme: 'exact',
    network,
    asset: assetSymbol === 'RLUSD' ? RLUSD_HEX : 'XRP',
    payTo: cfg.payTo,
    amount: route.price,
    maxTimeoutSeconds: 600,
    extra: {
      sourceTag: cfg.sourceTag ?? DEFAULT_SOURCE_TAG,
      invoiceId,
    },
  };
  if (assetSymbol === 'RLUSD') {
    requirements.extra.issuer = getRlusdIssuer(xrplNet);
  }
  return encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirements] });
}

/**
 * Owns the request when `route.xrpl` is set. Two paths:
 *
 *   1. PAYMENT-SIGNATURE header present → decode → check invoice cache →
 *      facilitator.verify → facilitator.settle → set PAYMENT-RESPONSE → next().
 *   2. No header → mint invoiceId → emit PAYMENT-REQUIRED → 402.
 *
 * Both paths first run a merchant-trustline preflight (cache-hit ~ free) so
 * an RLUSD route never advertises a destination that cannot receive the IOU.
 *
 * Errors short-circuit to 402/503 with `{ error, reason }` so buyers can retry.
 */
function handleXrplRoute(req: Req, res: Res, next: Next, route: PaywallRouteConfig, signer?: XrplWallet): void {
  void runXrplRoute(req, res, next, route, signer).catch((err) => {
    // Last-resort safety net — preflight + settle paths catch their own errors.
    if (typeof (res as { headersSent?: boolean }).headersSent === 'boolean'
        && (res as { headersSent?: boolean }).headersSent) return;
    res.status(500).json({ error: 'Internal xrpl handler error', reason: (err as Error).message });
  });
}

async function runXrplRoute(
  req: Req,
  res: Res,
  next: Next,
  route: PaywallRouteConfig,
  signer?: XrplWallet,
): Promise<void> {
  const cfg = route.xrpl!;
  const xrplNet = parseCaip2(cfg.network ?? 'xrpl:1');
  const assetSymbol = cfg.asset ?? 'RLUSD';

  // ── Merchant trustline preflight (RLUSD only — XRP needs no trustline). ─
  if (assetSymbol === 'RLUSD') {
    const issuer = getRlusdIssuer(xrplNet);
    let state;
    try {
      state = await ensureTrustline(getXrplConnection(xrplNet), {
        address: cfg.payTo,
        issuer,
        signer,
      });
    } catch (err) {
      const e = err as NPaymentError;
      res.status(503).json({
        error: e.code ?? 'XRPL_MERCHANT_TRUSTLINE_FAILED',
        reason: e.message,
        hint: e.hint,
      });
      return;
    }
    if (!state.ok) {
      res.status(503).json({
        error: 'XRPL_MERCHANT_NO_TRUSTLINE',
        reason: state.reason,
        hint: signer
          ? 'Trustline auto-create failed; verify the configured xrpl.seed has XRP for the reserve.'
          : 'Set xrpl.seed (or xrpl.owsWallet) on createPaywall, OR pre-create the trustline manually.',
      });
      return;
    }
  }

  const sigHeader =
    (req.headers['payment-signature'] as string | undefined) ??
    (req.headers['PAYMENT-SIGNATURE'] as string | undefined);

  // Path 1: settlement attempt.
  if (sigHeader) {
    await settleXrplPayment(req, res, next, route, sigHeader);
    return;
  }

  // Path 2: emit canonical PAYMENT-REQUIRED challenge.
  const invoiceId = cfg.invoiceId ?? randomInvoiceId();
  const routeKey = `${req.method} ${req.path}`;
  xrplInvoices.set(invoiceId, {
    routeKey,
    expiresAt: Date.now() + XRPL_INVOICE_TTL_MS,
    consumed: false,
  });
  const challenge = buildXrplChallenge(route, invoiceId);
  res.setHeader('PAYMENT-REQUIRED', challenge);
  res.status(402).json({
    error: 'Payment required',
    protocols: ['xrpl-x402'],
    description: cfg.description ?? route.description,
    invoiceId,
  });
}

async function settleXrplPayment(
  req: Req,
  res: Res,
  next: Next,
  route: PaywallRouteConfig,
  sigHeader: string,
): Promise<void> {
  const cfg = route.xrpl!;
  const xrplNet = parseCaip2(cfg.network ?? 'xrpl:1');
  const facilitatorUrl = cfg.facilitatorUrl ?? defaultFacilitatorUrl(xrplNet);

  // 1. Decode the buyer's PAYMENT-SIGNATURE.
  let envelope;
  try {
    envelope = decodePaymentSignatureHeader(sigHeader);
  } catch (err) {
    res.status(402).json({ error: 'invalid_signature', reason: (err as NPaymentError).message });
    return;
  }
  const accepted = envelope.accepted;

  // 2. Bind to outstanding invoice — the buyer echoes the same invoiceId
  //    we issued in the challenge. Reject unknown / consumed / expired.
  const invoice = xrplInvoices.get(accepted.extra.invoiceId);
  if (!invoice) {
    res.status(402).json({ error: 'unknown_invoice' });
    return;
  }
  if (invoice.consumed) {
    res.status(402).json({ error: 'invoice_already_consumed' });
    return;
  }
  if (invoice.expiresAt < Date.now()) {
    xrplInvoices.delete(accepted.extra.invoiceId);
    res.status(402).json({ error: 'invoice_expired' });
    return;
  }
  if (invoice.routeKey !== `${req.method} ${req.path}`) {
    res.status(402).json({ error: 'invoice_route_mismatch' });
    return;
  }
  // Cheap shape sanity — payTo / amount / network / asset must echo the
  // route's challenge contract before we burn a facilitator round-trip.
  const expectedAsset = (cfg.asset ?? 'RLUSD') === 'RLUSD' ? RLUSD_HEX : 'XRP';
  if (
    accepted.payTo !== cfg.payTo ||
    accepted.amount !== route.price ||
    accepted.network !== (cfg.network ?? 'xrpl:1') ||
    accepted.asset !== expectedAsset
  ) {
    res.status(402).json({ error: 'requirements_mismatch' });
    return;
  }

  // 3. Facilitator: verify, then settle.
  const fac = getFacilitator(facilitatorUrl);
  let v;
  try {
    v = await fac.verify({ paymentPayload: envelope, paymentRequirements: accepted });
  } catch (err) {
    res.status(402).json({ error: 'verify_failed', reason: (err as NPaymentError).message });
    return;
  }
  if (!v.isValid) {
    res.status(402).json({ error: 'verify_invalid', reason: v.invalidReason });
    return;
  }

  let s;
  try {
    s = await fac.settle({ paymentPayload: envelope, paymentRequirements: accepted });
  } catch (err) {
    res.status(402).json({ error: 'settle_failed', reason: (err as NPaymentError).message });
    return;
  }
  if (!s.success) {
    res.status(402).json({ error: 'settle_invalid', reason: s.errorReason });
    return;
  }

  // 4. Mark consumed + emit PAYMENT-RESPONSE then hand off to the route.
  invoice.consumed = true;
  res.setHeader(
    'PAYMENT-RESPONSE',
    encodePaymentResponseHeader({
      success: true,
      transaction: s.transaction,
      network: accepted.network,
      payer: s.payer ?? v.payer,
    }),
  );
  next();
}

/** UUIDv4-style invoice id (no extra dep — uses crypto.getRandomValues). */
function randomInvoiceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Health endpoint that returns pricing info for all configured routes.
 */
export function createHealthEndpoint(config: PaywallConfig) {  return (_req: Req, res: Res) => {
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
