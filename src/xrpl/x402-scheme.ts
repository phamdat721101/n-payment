/**
 * XRPL x402 — canonical wire format and merchant-side facilitator HTTP client.
 *
 * Implements the T54 reference spec for x402 over XRPL:
 *   https://xrpl-x402.t54.ai/docs/xrpl-scheme
 *   https://xrpl.org/docs/agents/agentic-payments-x402
 *
 * Single responsibility: speak the wire. This module performs no XRPL ledger
 * work (that is in `payments.ts`), and does no HTTP framework integration
 * (that is in `middleware.ts`). It only:
 *
 *   - encodes/decodes the three x402 v2 headers (PAYMENT-REQUIRED,
 *     PAYMENT-SIGNATURE, PAYMENT-RESPONSE) as base64-JSON
 *   - builds the invoice-binding `Memo` per spec
 *   - speaks `POST /verify` and `POST /settle` against any spec-compliant
 *     facilitator (T54-hosted or self-hosted)
 *
 * The buyer adapter consumes the encoders/decoders.
 * The merchant middleware consumes both the encoders/decoders and the
 * facilitator client.
 */

import { NPaymentError } from '../errors.js';
import {
  RLUSD_HEX,
  type XrplCaip2,
  type XrplNetwork,
  parseCaip2,
} from './utils.js';

// ─── Wire-format types (T54 / x402 v2) ───────────────────────────────────────

/**
 * `accepts[i]` shape per the XRPL exact scheme. Always emitted by the merchant
 * inside `PAYMENT-REQUIRED`; echoed by the buyer inside `PAYMENT-SIGNATURE.accepted`.
 */
export interface XrplPaymentRequirements {
  scheme: 'exact';
  network: XrplCaip2;
  /** "XRP" or 40-hex canonical currency code (e.g. RLUSD_HEX). */
  asset: string;
  /** XRPL classic destination address (r…). */
  payTo: string;
  /** Drops as integer string for XRP; decimal string for IOU. */
  amount: string;
  /** Bounded validity window, in seconds. */
  maxTimeoutSeconds: number;
  extra: {
    sourceTag: number;
    invoiceId: string;
    /** Required for IOU assets (e.g. RLUSD); absent for XRP. */
    issuer?: string;
    /** Optional XRPL DestinationTag. */
    destinationTag?: number;
  };
}

/** PAYMENT-REQUIRED body (server → client). */
export interface PaymentRequiredEnvelope {
  x402Version: 2;
  accepts: XrplPaymentRequirements[];
}

/** PAYMENT-SIGNATURE body (client → server). */
export interface PaymentSignatureEnvelope {
  x402Version: 2;
  accepted: XrplPaymentRequirements;
  /**
   * Signed XRPL Payment payload.
   *
   * - `signedTxBlob` — hex of the buyer-signed Payment transaction.
   * - `invoiceId`   — the same invoice identifier carried in
   *   `accepted.extra.invoiceId`. The T54 reference facilitator and
   *   reference x402-xrpl Python client (server/fastapi.py L366,
   *   client/presigned_payment_payer.py L230-L238) read the invoice id
   *   from this field for invoice-binding verification, not from
   *   `accepted.extra`. Without it the facilitator returns
   *   `invalidReason="invalid_payload"`.
   */
  payload: { signedTxBlob: string; invoiceId?: string };
}

/** PAYMENT-RESPONSE body (server → client, on success). */
export interface PaymentResponseEnvelope {
  success: boolean;
  transaction?: string;
  network?: XrplCaip2;
  payer?: string;
  errorReason?: string;
}

// ─── base64-JSON helpers (cross-runtime) ─────────────────────────────────────

const encodeBase64 = (str: string): string =>
  typeof Buffer !== 'undefined'
    ? Buffer.from(str, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(str)));

const decodeBase64 = (b64: string): string =>
  typeof Buffer !== 'undefined'
    ? Buffer.from(b64, 'base64').toString('utf8')
    : decodeURIComponent(escape(atob(b64)));

// ─── Encode / decode ─────────────────────────────────────────────────────────

/** Encode a PAYMENT-REQUIRED challenge to its base64 header value. */
export function encodePaymentRequiredHeader(env: PaymentRequiredEnvelope): string {
  assertRequired(env);
  return encodeBase64(JSON.stringify(env));
}

/** Decode a PAYMENT-REQUIRED header value. Throws on malformed/missing fields. */
export function decodePaymentRequiredHeader(headerVal: string): PaymentRequiredEnvelope {
  const env = parseJson<PaymentRequiredEnvelope>(headerVal, 'PAYMENT-REQUIRED');
  assertRequired(env);
  return env;
}

/** Encode a PAYMENT-SIGNATURE retry header value. */
export function encodePaymentSignatureHeader(env: PaymentSignatureEnvelope): string {
  assertSignature(env);
  return encodeBase64(JSON.stringify(env));
}

/** Decode a PAYMENT-SIGNATURE header value. Throws on malformed/missing fields. */
export function decodePaymentSignatureHeader(headerVal: string): PaymentSignatureEnvelope {
  const env = parseJson<PaymentSignatureEnvelope>(headerVal, 'PAYMENT-SIGNATURE');
  assertSignature(env);
  return env;
}

/** Encode a PAYMENT-RESPONSE settlement header value. */
export function encodePaymentResponseHeader(env: PaymentResponseEnvelope): string {
  return encodeBase64(JSON.stringify(env));
}

/** Decode a PAYMENT-RESPONSE header value. Returns null on malformed input. */
export function decodePaymentResponseHeader(headerVal: string): PaymentResponseEnvelope | null {
  try {
    return JSON.parse(decodeBase64(headerVal)) as PaymentResponseEnvelope;
  } catch {
    return null;
  }
}

// ─── Invoice binding (Memo method) ───────────────────────────────────────────

/** Max bytes per XRPL Memo field (rippled-enforced ceiling). */
const MEMO_MAX_BYTES = 1024;

/**
 * Build the XRPL `Memos` entry that binds the signed transaction to a specific
 * invoice. The facilitator validates `MemoData = hex(UTF-8(invoiceId))` per the
 * "Method A: Memos" rule of the XRPL exact scheme.
 *
 * We use Memo binding (not InvoiceID) because it is debuggable in account_tx
 * output and is what T54's `x402scan` indexer surfaces.
 */
export function hexInvoiceMemo(invoiceId: string): { Memo: { MemoData: string } } {
  if (!invoiceId || typeof invoiceId !== 'string') {
    throw new NPaymentError('Invoice ID required for x402 Memo binding', 'XRPL_INVALID_INVOICE');
  }
  // Encode UTF-8 → hex, uppercase (XRPL convention).
  let hex = '';
  for (const byte of new TextEncoder().encode(invoiceId)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  hex = hex.toUpperCase();
  if (hex.length / 2 > MEMO_MAX_BYTES) {
    throw new NPaymentError(
      `Invoice ID too large for Memo (${hex.length / 2} > ${MEMO_MAX_BYTES} bytes)`,
      'XRPL_INVOICE_TOO_LARGE',
      'Use a shorter invoice identifier (UUIDv4 recommended).',
    );
  }
  return { Memo: { MemoData: hex } };
}

// ─── Default facilitator URL resolution ──────────────────────────────────────

const DEFAULT_T54_FACILITATORS: Readonly<Record<XrplNetwork, string>> = Object.freeze({
  mainnet: 'https://xrpl-facilitator-mainnet.t54.ai',
  testnet: 'https://xrpl-facilitator-testnet.t54.ai',
});

/** Default facilitator URL per network. T54-hosted; override via config. */
export function defaultFacilitatorUrl(network: XrplNetwork): string {
  return DEFAULT_T54_FACILITATORS[network];
}

// ─── Facilitator HTTP client ─────────────────────────────────────────────────

export interface FacilitatorVerifyInput {
  paymentPayload: PaymentSignatureEnvelope;
  paymentRequirements: XrplPaymentRequirements;
}

export interface FacilitatorVerifyResult {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface FacilitatorSettleResult {
  success: boolean;
  transaction?: string;
  network?: XrplCaip2;
  payer?: string;
  errorReason?: string;
}

/**
 * Thin HTTP client for any spec-compliant XRPL x402 facilitator (T54 hosted
 * by default). Two responsibilities only: `POST /verify` and `POST /settle`.
 *
 * SOLID — DIP: `fetchImpl` is injected so unit tests can pass a mock without
 * stubbing globals; defaults to the runtime `fetch` resolved at call-time
 * (so a later `globalThis.fetch` swap is picked up).
 */
export class XrplFacilitatorClient {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(baseUrl: string, fetchImpl?: typeof fetch) {
    if (!baseUrl) {
      throw new NPaymentError(
        'Facilitator base URL required',
        'XRPL_FACILITATOR_NO_URL',
        'Pass a URL or rely on defaultFacilitatorUrl(network).',
      );
    }
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  verify(input: FacilitatorVerifyInput): Promise<FacilitatorVerifyResult> {
    return this.post<FacilitatorVerifyResult>('/verify', input);
  }

  settle(input: FacilitatorVerifyInput): Promise<FacilitatorSettleResult> {
    return this.post<FacilitatorSettleResult>('/settle', input);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const f = this.fetchImpl ?? globalThis.fetch;
    let res: Response;
    try {
      res = await f(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new NPaymentError(
        `Facilitator unreachable: ${(err as Error).message}`,
        'XRPL_FACILITATOR_UNREACHABLE',
        `Check ${this.baseUrl} or override xrpl.facilitatorUrl.`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new NPaymentError(
        `Facilitator ${path} HTTP ${res.status}: ${detail.slice(0, 200)}`,
        'XRPL_FACILITATOR_FAILED',
        'See facilitator logs; the request body may have been malformed.',
      );
    }
    return (await res.json()) as T;
  }
}

// ─── Internal validators ─────────────────────────────────────────────────────

function parseJson<T>(headerVal: string, label: string): T {
  if (typeof headerVal !== 'string' || headerVal.length === 0) {
    throw new NPaymentError(`Missing ${label} header`, 'XRPL_X402_MISSING_HEADER');
  }
  let json: string;
  try {
    json = decodeBase64(headerVal);
  } catch {
    throw new NPaymentError(`Malformed ${label} header (base64 decode failed)`, 'XRPL_X402_INVALID_HEADER');
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new NPaymentError(`Malformed ${label} header (JSON parse failed)`, 'XRPL_X402_INVALID_HEADER');
  }
}

function assertRequirements(req: XrplPaymentRequirements): void {
  if (req.scheme !== 'exact') throw err('scheme must be "exact"');
  parseCaip2(req.network); // throws on unknown
  if (typeof req.asset !== 'string' || req.asset.length === 0) throw err('asset required');
  if (req.asset !== 'XRP' && !/^[0-9A-F]{40}$/i.test(req.asset)) {
    throw err('asset must be "XRP" or 40-hex currency code');
  }
  if (typeof req.payTo !== 'string' || !req.payTo.startsWith('r')) {
    throw err('payTo must be an XRPL classic address (r…)');
  }
  if (typeof req.amount !== 'string' || req.amount.length === 0) throw err('amount required');
  if (!Number.isFinite(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) {
    throw err('maxTimeoutSeconds must be positive');
  }
  if (!req.extra || typeof req.extra !== 'object') throw err('extra required');
  if (typeof req.extra.invoiceId !== 'string' || req.extra.invoiceId.length === 0) {
    throw err('extra.invoiceId required');
  }
  if (!Number.isInteger(req.extra.sourceTag) || req.extra.sourceTag < 0) {
    throw err('extra.sourceTag must be a non-negative integer');
  }
  // IOU (non-XRP) assets MUST carry the issuer.
  if (req.asset !== 'XRP' && (typeof req.extra.issuer !== 'string' || !req.extra.issuer.startsWith('r'))) {
    throw err('extra.issuer required for IOU assets (e.g. RLUSD)');
  }
}

function assertRequired(env: PaymentRequiredEnvelope): void {
  if (!env || env.x402Version !== 2) throw err('x402Version must be 2');
  if (!Array.isArray(env.accepts) || env.accepts.length === 0) throw err('accepts must be non-empty');
  for (const a of env.accepts) assertRequirements(a);
}

function assertSignature(env: PaymentSignatureEnvelope): void {
  if (!env || env.x402Version !== 2) throw err('x402Version must be 2');
  if (!env.accepted) throw err('accepted required');
  assertRequirements(env.accepted);
  if (!env.payload?.signedTxBlob || typeof env.payload.signedTxBlob !== 'string') {
    throw err('payload.signedTxBlob required');
  }
}

function err(msg: string): NPaymentError {
  return new NPaymentError(`Invalid x402 envelope: ${msg}`, 'XRPL_X402_INVALID_ENVELOPE');
}

// ─── Re-exports for callers that only import this module ─────────────────────
export { RLUSD_HEX };
