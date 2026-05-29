/**
 * Morph Hoodi custom x402 facilitator (v0.18).
 *
 * Self-contained, single-file implementation of Morph Rails' three endpoints
 * (`/v2/supported`, `/v2/verify`, `/v2/settle`) for the Hoodi testnet, with
 * **EIP-3009 sponsored** transferWithAuthorization submission so buyers pay
 * **zero ETH** for gas.
 *
 * Design principles (SOLID):
 *   - Single Responsibility: this file orchestrates three HTTP endpoints; the
 *     EIP-3009 typed-data + signature helpers live in `./eip3009.ts`, the HMAC
 *     auth helper in `./auth.ts`. Nothing here is reimplemented.
 *   - Open/Closed: new schemes plug in via the `kind` filter in `/v2/supported`.
 *     The verify/settle handlers branch only on the `scheme: 'eip3009'` value
 *     they receive — no chain-specific switches inside the handler.
 *   - Dependency Inversion: the on-chain client + sponsor account are injected
 *     via factory params. Tests pass viem mocks directly; the production runner
 *     in `examples/morph-hoodi-facilitator.ts` constructs viem clients from
 *     `chains.ts`.
 *
 * Replay protection: in-memory `Set<nonce>` (per-process). Sufficient for
 * testnet; production callers run a stateful gateway in front of this layer.
 *
 * No DB, no extra deps. Boots in <100ms. Single Express handler.
 */
import type { Address, Hex, PublicClient, WalletClient } from 'viem';
import { signMorphRequest } from './auth.js';
import {
  decodeAuthorizationPayload,
  buildTransferWithAuthorizationTypedData,
  splitSignature,
  EIP3009_ABI,
} from './eip3009.js';
import { NPaymentError } from '../errors.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface MorphHoodiFacilitatorConfig {
  /** Hoodi USDC address (0x7433…b661B for our deploy). */
  usdcAddress: Address;
  /** EIP-712 domain name for the USDC contract. @default 'USD Coin' */
  tokenName?: string;
  /** EIP-712 domain version. @default '2' */
  tokenVersion?: string;
  /** Required: viem PublicClient pointed at Hoodi RPC. */
  publicClient: PublicClient;
  /** Required: viem WalletClient backed by the sponsor account (pays gas). */
  sponsorClient: WalletClient;
  /** Sponsor address (used for receipt validation). */
  sponsorAddress: Address;
  /** Network CAIP-2 id. @default 'eip155:2910' */
  network?: string;
  /** When `accessKey`/`secretKey` are set, every /v2/verify and /v2/settle call must pass HMAC. */
  accessKey?: string;
  secretKey?: string;
  /** Override the path prefix. @default '/x402' */
  pathPrefix?: string;
  /** Maximum clock skew allowed for HMAC timestamps in ms. @default 30_000 */
  hmacSkewMs?: number;
}

interface MinimalReq {
  method: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface MinimalRes {
  status(code: number): MinimalRes;
  json(body: unknown): unknown;
}

type Handler = (req: MinimalReq, res: MinimalRes) => Promise<unknown> | unknown;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the Express request handler for the Hoodi facilitator.
 *
 *   app.use(express.json());
 *   app.use(createMorphHoodiFacilitator({ ...cfg }));
 *
 * The handler routes by `req.path` against `pathPrefix + endpoint` so it is
 * mountable at any base path.
 */
export function createMorphHoodiFacilitator(cfg: MorphHoodiFacilitatorConfig): Handler {
  const prefix = (cfg.pathPrefix ?? '/x402').replace(/\/$/, '');
  const requireHmac = !!(cfg.accessKey && cfg.secretKey);
  const seenNonces = new Set<Hex>();

  const supported: Handler = (_req, res) =>
    res.status(200).json({
      kinds: [{ x402Version: 2, scheme: 'eip3009', network: cfg.network ?? 'eip155:2910' }],
      extensions: [],
      signers: { [cfg.network ?? 'eip155:2910']: [cfg.sponsorAddress] },
    });

  const verify: Handler = async (req, res) => {
    const result = await runVerify(req, cfg, seenNonces, /* consumeNonce */ false);
    return res.status(result.httpStatus).json(result.body);
  };

  const settle: Handler = async (req, res) => {
    const verifyResult = await runVerify(req, cfg, seenNonces, /* consumeNonce */ true);
    if (verifyResult.httpStatus !== 200 || !verifyResult.auth || !verifyResult.signature) {
      return res.status(verifyResult.httpStatus).json(verifyResult.body);
    }
    try {
      const txHash = await submitOnChain(cfg, verifyResult.auth, verifyResult.signature);
      return res.status(200).json({
        success: true,
        payer: verifyResult.auth.from,
        transaction: txHash,
        network: cfg.network ?? 'eip155:2910',
      });
    } catch (err) {
      seenNonces.delete(verifyResult.auth.nonce); // free nonce on failure so caller may retry
      const message = err instanceof Error ? err.message : 'unknown error';
      return res.status(500).json({ success: false, errorReason: `submit failed: ${message}` });
    }
  };

  return async (req, res) => {
    if (!isOurPath(req, prefix)) return res.status(404).json({ error: 'not found' });
    if (requireHmac && !verifyHmac(req, cfg)) {
      return res.status(401).json({ success: false, errorReason: 'invalid HMAC signature' });
    }
    const subpath = stripPrefix(reqPath(req), prefix);
    if (subpath === '/v2/supported' && req.method === 'GET') return supported(req, res);
    if (subpath === '/v2/verify' && req.method === 'POST') return verify(req, res);
    if (subpath === '/v2/settle' && req.method === 'POST') return settle(req, res);
    return res.status(404).json({ error: `unknown route ${req.method} ${subpath}` });
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

interface VerifyResult {
  httpStatus: number;
  body: Record<string, unknown>;
  auth?: ReturnType<typeof decodeAuthorizationPayload>;
  signature?: Hex;
}

/**
 * Verify a payment payload. When `consumeNonce` is true, the nonce is registered
 * in the dedupe set on success (used by /v2/settle); when false, it is only
 * peeked (used by /v2/verify).
 */
async function runVerify(
  req: MinimalReq,
  cfg: MorphHoodiFacilitatorConfig,
  seenNonces: Set<Hex>,
  consumeNonce: boolean,
): Promise<VerifyResult> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requirements = body.paymentRequirements as Record<string, unknown> | undefined;
  const payload = body.paymentPayload as Record<string, unknown> | undefined;
  if (!requirements || !payload) {
    return fail(400, 'missing paymentRequirements or paymentPayload', 'BAD_REQUEST');
  }

  // Asset / network sanity (fail fast — independent of signature work).
  const expectedAsset = cfg.usdcAddress.toLowerCase();
  const reqAsset = String(requirements.asset ?? '').toLowerCase();
  if (reqAsset && reqAsset !== expectedAsset) {
    return fail(400, `asset ${reqAsset} not supported (expected ${expectedAsset})`, 'ASSET_MISMATCH');
  }
  const expectedNetwork = cfg.network ?? 'eip155:2910';
  if (requirements.network && requirements.network !== expectedNetwork) {
    return fail(400, `network ${requirements.network} not supported (expected ${expectedNetwork})`, 'NETWORK_MISMATCH');
  }

  let auth: ReturnType<typeof decodeAuthorizationPayload>;
  let signature: Hex;
  try {
    auth = decodeAuthorizationPayload(payload.authorization);
    signature = payload.signature as Hex;
    if (!signature || !signature.startsWith('0x')) throw new Error('signature missing or malformed');
  } catch (err) {
    return fail(400, `invalid authorization payload: ${(err as Error).message}`, 'BAD_AUTHORIZATION');
  }

  // Time window
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (auth.validAfter > now) return fail(400, 'authorization not yet valid', 'AUTH_NOT_YET_VALID');
  if (auth.validBefore <= now) return fail(400, 'authorization expired', 'AUTH_EXPIRED');

  // Amount must cover requirement
  const required = BigInt(String(requirements.maxAmountRequired ?? '0'));
  if (auth.value < required) {
    return fail(400, `authorization value ${auth.value} < required ${required}`, 'AMOUNT_TOO_LOW');
  }
  // payTo must match
  const payTo = String(requirements.payTo ?? '').toLowerCase();
  if (payTo && auth.to.toLowerCase() !== payTo) {
    return fail(400, `authorization to ${auth.to} != payTo ${payTo}`, 'PAYTO_MISMATCH');
  }

  // Replay (in-memory)
  if (seenNonces.has(auth.nonce)) {
    return fail(409, `nonce ${auth.nonce} already used`, 'MORPH_NONCE_REPLAYED');
  }

  // Recover signer from EIP-712 typed data — must equal `auth.from`.
  const td = buildTransferWithAuthorizationTypedData({
    verifyingContract: cfg.usdcAddress,
    chainId: cfg.publicClient.chain?.id ?? Number((cfg.network ?? 'eip155:2910').split(':')[1]),
    tokenName: cfg.tokenName,
    tokenVersion: cfg.tokenVersion,
    authorization: auth,
  });
  const { recoverTypedDataAddress } = await import('viem');
  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain: td.domain, types: td.types, primaryType: td.primaryType,
      message: td.message, signature,
    });
  } catch (err) {
    return fail(400, `signature recovery failed: ${(err as Error).message}`, 'BAD_SIGNATURE');
  }
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    return fail(400, `recovered ${recovered} != from ${auth.from}`, 'SIGNATURE_MISMATCH');
  }

  // On-chain replay check (best-effort — facilitator may not have RPC during unit tests).
  try {
    const used = (await cfg.publicClient.readContract({
      address: cfg.usdcAddress,
      abi: EIP3009_ABI,
      functionName: 'authorizationState',
      args: [auth.from, auth.nonce],
    })) as boolean;
    if (used) return fail(409, 'authorizationState true on-chain', 'AUTHORIZATION_USED');
  } catch (err) {
    // Bubble up as a 502 so callers know their RPC is unhealthy — but only on /v2/settle.
    if (consumeNonce) {
      return fail(502, `authorizationState read failed: ${(err as Error).message}`, 'RPC_UNAVAILABLE');
    }
  }

  if (consumeNonce) seenNonces.add(auth.nonce);

  return {
    httpStatus: 200,
    body: { isValid: true, payer: auth.from },
    auth, signature,
  };
}

function fail(httpStatus: number, msg: string, code: string): VerifyResult {
  return { httpStatus, body: { isValid: false, success: false, invalidReason: msg, errorReason: msg, code } };
}

async function submitOnChain(
  cfg: MorphHoodiFacilitatorConfig,
  auth: ReturnType<typeof decodeAuthorizationPayload>,
  signature: Hex,
): Promise<Hex> {
  const { v, r, s } = splitSignature(signature);
  const txHash = await cfg.sponsorClient.writeContract({
    address: cfg.usdcAddress,
    abi: EIP3009_ABI,
    functionName: 'transferWithAuthorization',
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, v, r, s],
    account: cfg.sponsorClient.account ?? cfg.sponsorAddress,
    chain: cfg.sponsorClient.chain ?? null,
  } as never);
  // Wait for receipt (so caller gets a confirmed tx, not a mempool optimistic hash)
  const receipt = await cfg.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
  if (receipt.status !== 'success') {
    throw new NPaymentError(`tx ${txHash} reverted on Hoodi`, 'TX_REVERTED');
  }
  return txHash;
}

function isOurPath(req: MinimalReq, prefix: string): boolean {
  const path = reqPath(req);
  return path.startsWith(`${prefix}/`);
}

function reqPath(req: MinimalReq): string {
  if (req.path) return req.path;
  const raw = req.originalUrl ?? req.url ?? '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function verifyHmac(req: MinimalReq, cfg: MorphHoodiFacilitatorConfig): boolean {
  const accessKey = headerValue(req, 'morph-access-key');
  const timestamp = headerValue(req, 'morph-access-timestamp');
  const sign = headerValue(req, 'morph-access-sign');
  if (!accessKey || !timestamp || !sign) return false;
  if (accessKey !== cfg.accessKey) return false;
  const skew = cfg.hmacSkewMs ?? 30_000;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > skew) return false;
  const path = reqPath(req);
  const bodyStr = req.body ? JSON.stringify(req.body) : undefined;
  const expected = signMorphRequest({
    method: req.method,
    path,
    body: bodyStr,
    accessKey: cfg.accessKey!,
    secretKey: cfg.secretKey!,
    timestamp,
  });
  return expected['MORPH-ACCESS-SIGN'] === sign;
}

function headerValue(req: MinimalReq, key: string): string | undefined {
  const v = req.headers[key] ?? req.headers[key.toUpperCase()];
  if (Array.isArray(v)) return v[0];
  return v as string | undefined;
}
