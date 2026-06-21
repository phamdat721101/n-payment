import type { XrplWallet } from './wallet.js';
import type { XrplConnection } from './connection.js';
import { DEFAULT_SOURCE_TAG, RLUSD_CURRENCY } from './utils.js';
import { hexInvoiceMemo } from './x402-scheme.js';
import { NPaymentError } from '../errors.js';

// ─── Shared types ────────────────────────────────────────────────────────────

export interface RlusdAmount {
  currency: string;
  issuer: string;
  value: string;
}

export interface IssuerOpts {
  issuer: string;
  currency?: string;
}

const rlusdAmount = (issuer: string, value: string, currency: string = RLUSD_CURRENCY): RlusdAmount =>
  ({ currency, issuer, value });

// ─── Trust-line bootstrap (unified — buyer & merchant) ─────────────────────

/**
 * Resolved trust-line state for a single (address, issuer, currency) tuple.
 * Returned by `ensureTrustline`. Both ok and not-ok states carry an
 * actionable hint so callers can render a clear 503 or log line.
 */
export interface TrustlineState {
  /** True when the trustline exists on the configured network. */
  ok: boolean;
  /** When ok=false, the canonical reason. */
  reason?: 'missing' | 'frozen' | 'limit_too_low';
  /** Tx hash of the TrustSet, when this call created the line. */
  txHash?: string;
  /** True when the trustline was already present prior to this call. */
  alreadyExisted?: boolean;
  /** Operator-facing hint matching `reason`. */
  hint?: string;
}

/** Options for `ensureTrustline`. SOLID-DRY: same shape used by buyer + merchant. */
export interface EnsureTrustlineOpts {
  /** Address that must own the trustline (buyer self-address OR merchant payTo). */
  address: string;
  /** Issuer of the IOU (e.g. RLUSD issuer for the network). */
  issuer: string;
  /**
   * When provided AND the trustline is missing, sign + submit a TrustSet.
   * `signer.getAddress()` MUST equal `address` — mismatch throws
   * `XRPL_TRUSTLINE_SIGNER_MISMATCH` (defence-in-depth against accidental
   * cross-wallet config). Omit to run in fail-fast read-only mode.
   */
  signer?: XrplWallet;
  /** @default RLUSD_CURRENCY */
  currency?: string;
  /** TrustSet limit value (decimal string). @default '1000000000' */
  limit?: string;
  /** Cache TTL in ms. @default 300_000 (5 min) */
  cacheTtlMs?: number;
}

/** Default cache TTL for trustline state. Trustline changes are rare. */
const TRUSTLINE_CACHE_TTL_MS = 5 * 60 * 1000;

interface TrustlineCacheEntry { state: TrustlineState; expiresAt: number }
const trustlineCache = new Map<string, TrustlineCacheEntry>();
const trustlineLocks = new Map<string, Promise<TrustlineState>>();

const trustlineCacheKey = (address: string, issuer: string, currency: string): string =>
  `${address}|${issuer}|${currency}`;

/**
 * Idempotent trustline preflight used by both the buyer adapter and the
 * merchant paywall middleware. Reads `account_lines` once, caches the result
 * for ~5 min, and (when a signer is provided) auto-creates the line on miss.
 *
 * Behaviour matrix:
 *
 *   exists                             → { ok: true, alreadyExisted: true }
 *   missing + signer (matching addr)   → submits TrustSet, { ok: true, txHash }
 *   missing + signer (mismatch)        → throws XRPL_TRUSTLINE_SIGNER_MISMATCH
 *   missing + no signer                → { ok: false, reason: 'missing', hint }
 *
 * Concurrency: a per-address mutex coalesces parallel calls so two requests
 * arriving at the same paywall replica never submit two TrustSet txs.
 *
 * SOLID — SRP: this function does one thing (resolve trustline state).
 *        DIP : depends on the `XrplConnection` + `XrplWallet` interfaces, not
 *              concrete classes; unit tests inject mocks.
 */
export async function ensureTrustline(
  connection: XrplConnection,
  opts: EnsureTrustlineOpts,
): Promise<TrustlineState> {
  const {
    address,
    issuer,
    signer,
    currency = RLUSD_CURRENCY,
    limit = '1000000000',
    cacheTtlMs = TRUSTLINE_CACHE_TTL_MS,
  } = opts;

  const cacheKey = trustlineCacheKey(address, issuer, currency);
  const now = Date.now();
  const hit = trustlineCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return hit.state;

  // Coalesce parallel callers on the same key — return the in-flight promise.
  const inflight = trustlineLocks.get(cacheKey);
  if (inflight) return inflight;

  const work = (async (): Promise<TrustlineState> => {
    const client = await connection.getClient();
    const lines = await client.request({ command: 'account_lines', account: address });
    const exists = lines.result.lines?.some(
      (l: { currency: string; account: string }) => l.currency === currency && l.account === issuer,
    );
    if (exists) {
      const state: TrustlineState = { ok: true, alreadyExisted: true };
      trustlineCache.set(cacheKey, { state, expiresAt: Date.now() + cacheTtlMs });
      return state;
    }

    if (!signer) {
      const state: TrustlineState = {
        ok: false,
        reason: 'missing',
        hint: `Address ${address} has no ${currency} trustline to issuer ${issuer}. ` +
          'Pass a signer (xrpl.seed/xrpl.owsWallet on createPaywall) to auto-create, ' +
          'or pre-create the trustline manually.',
      };
      // Cache the negative result briefly — operator may pre-create the line.
      trustlineCache.set(cacheKey, { state, expiresAt: Date.now() + cacheTtlMs });
      return state;
    }

    const signerAddress = await signer.getAddress();
    if (signerAddress !== address) {
      throw new NPaymentError(
        `Trustline signer address mismatch: signer=${signerAddress}, expected=${address}`,
        'XRPL_TRUSTLINE_SIGNER_MISMATCH',
        'The signer (xrpl.seed/xrpl.owsWallet) must derive the same XRPL classic address as the trustline owner (route.xrpl.payTo or buyer self-address).',
      );
    }

    const tx = await client.autofill({
      TransactionType: 'TrustSet',
      Account: address,
      LimitAmount: { currency, issuer, value: limit },
    });
    const signed = await signer.sign(tx);
    if (!signed.tx_blob) {
      throw new NPaymentError(
        'TrustSet signer did not return a signed tx_blob',
        'XRPL_TRUSTLINE_SIGN_FAILED',
        'OWS-only signers may not yet expose tx_blob for XRPL TrustSet; pre-create the trustline manually.',
      );
    }
    const result = await client.submitAndWait(signed.tx_blob);
    const txHash = result.result.hash as string | undefined;
    const state: TrustlineState = { ok: true, txHash };
    trustlineCache.set(cacheKey, { state, expiresAt: Date.now() + cacheTtlMs });
    return state;
  })();

  trustlineLocks.set(cacheKey, work);
  try {
    return await work;
  } finally {
    if (trustlineLocks.get(cacheKey) === work) trustlineLocks.delete(cacheKey);
  }
}

/** Test/operational helper — drop the entire trustline cache. */
export function clearTrustlineCache(): void { trustlineCache.clear(); }

/**
 * @internal Test helper — pre-seed the trustline cache for `(address, issuer)`
 * as `{ ok: true, alreadyExisted: true }`. Lets test files that don't mock the
 * XRPL connection skip the preflight network round-trip.
 */
export function _seedTrustlineCacheOk(
  address: string,
  issuer: string,
  currency: string = RLUSD_CURRENCY,
): void {
  trustlineCache.set(trustlineCacheKey(address, issuer, currency), {
    state: { ok: true, alreadyExisted: true },
    expiresAt: Date.now() + TRUSTLINE_CACHE_TTL_MS,
  });
}

/**
 * Back-compat wrapper preserving the v0.28 `ensureTrustLine` signature
 * exported from `src/index.ts`. Delegates to the unified `ensureTrustline`.
 *
 * Returned value mirrors the legacy contract:
 *   - `null` when the trustline already existed
 *   - the TrustSet tx hash when this call created it
 *
 * @deprecated Prefer `ensureTrustline` (returns `TrustlineState`); kept for
 *             external callers depending on the v0.28 surface.
 */
export async function ensureTrustLine(
  connection: XrplConnection,
  wallet: XrplWallet,
  opts: IssuerOpts & { limit?: string },
): Promise<string | null> {
  const address = await wallet.getAddress();
  const state = await ensureTrustline(connection, {
    address,
    issuer: opts.issuer,
    signer: wallet,
    currency: opts.currency,
    limit: opts.limit,
  });
  if (state.alreadyExisted) return null;
  return state.txHash ?? null;
}

// ─── RLUSD send (Payment) ────────────────────────────────────────────────────

export async function sendRLUSD(
  connection: XrplConnection,
  wallet: XrplWallet,
  destination: string,
  amount: string,
  opts: IssuerOpts,
): Promise<{ hash: string; validated: boolean }> {
  const client = await connection.getClient();
  const address = await wallet.getAddress();

  const tx = await client.autofill({
    TransactionType: 'Payment',
    Account: address,
    Destination: destination,
    Amount: rlusdAmount(opts.issuer, amount, opts.currency),
  });
  const signed = await wallet.sign(tx);
  const result = await client.submitAndWait(signed.tx_blob);
  invalidateAccountState(address);
  return { hash: result.result.hash, validated: result.result.validated ?? false };
}

// ─── Balance read ────────────────────────────────────────────────────────────

export async function getRLUSDBalance(
  connection: XrplConnection,
  address: string,
  opts: IssuerOpts,
): Promise<string> {
  const client = await connection.getClient();
  const lines = await client.request({ command: 'account_lines', account: address });
  const rlusd = lines.result.lines?.find(
    (l: { currency: string; account: string; balance: string }) =>
      l.currency === (opts.currency ?? RLUSD_CURRENCY) && l.account === opts.issuer,
  );
  return rlusd?.balance ?? '0';
}

// ─── Single-shot account state (Gstack P1+P3 fix) ────────────────────────────

export interface AccountState {
  /** Account address (XRPL classic). */
  address: string;
  /** XRP balance in drops (1 XRP = 1_000_000 drops). */
  xrpDrops: bigint;
  /** RLUSD balance as a decimal string (matches `account_lines.balance`). */
  rlusdBalance: string;
  /** Whether an RLUSD trust line is set to the configured issuer. */
  trustlineExists: boolean;
  /** Account sequence number (for client-side sequence reservation, optional). */
  sequence?: number;
  /** Cache freshness — milliseconds since the read landed. */
  ageMs: number;
}

interface CacheEntry { state: AccountState; expiresAt: number }
const CACHE_TTL_MS = 4_000; // ~1 ledger close on XRPL
const stateCache = new Map<string, CacheEntry>();

/**
 * Read xrpDrops + rlusdBalance + trustlineExists + sequence in one round-trip
 * pair (`account_info` + `account_lines`). Cached for ~1 ledger close.
 *
 * Pass `{ fresh: true }` to bypass the cache (used after a state-changing tx).
 */
export async function readAccountState(
  connection: XrplConnection,
  address: string,
  opts: IssuerOpts & { fresh?: boolean },
): Promise<AccountState> {
  const cacheKey = `${address}|${opts.issuer}|${opts.currency ?? RLUSD_CURRENCY}`;
  const now = Date.now();
  if (!opts.fresh) {
    const hit = stateCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      return { ...hit.state, ageMs: now - (hit.expiresAt - CACHE_TTL_MS) };
    }
  }

  const client = await connection.getClient();
  const [info, lines] = await Promise.all([
    client.request({ command: 'account_info', account: address }),
    client.request({ command: 'account_lines', account: address }),
  ]);

  const xrpDrops = BigInt(info.result.account_data?.Balance ?? '0');
  const sequence: number | undefined = info.result.account_data?.Sequence;
  const currency = opts.currency ?? RLUSD_CURRENCY;
  const rlusdLine = lines.result.lines?.find(
    (l: { currency: string; account: string; balance: string }) =>
      l.currency === currency && l.account === opts.issuer,
  );
  const trustlineExists = !!rlusdLine;
  const rlusdBalance = rlusdLine?.balance ?? '0';

  const state: AccountState = {
    address,
    xrpDrops,
    rlusdBalance,
    trustlineExists,
    sequence,
    ageMs: 0,
  };
  stateCache.set(cacheKey, { state, expiresAt: now + CACHE_TTL_MS });
  return state;
}

/** Test/operational helper — drop the entire account-state cache. */
export function clearAccountStateCache(): void { stateCache.clear(); }

/** Drop all cache entries for a given address (after a state-changing tx). */
export function invalidateAccountState(address: string): void {
  const prefix = `${address}|`;
  for (const key of stateCache.keys()) {
    if (key.startsWith(prefix)) stateCache.delete(key);
  }
}

// ─── X402 — presigned RLUSD Payment builder (T54 exact scheme) ───────────────

/** Default LastLedgerSequence lookahead in ledgers (~80s at 4s closes). */
const DEFAULT_LAST_LEDGER_OFFSET = 20;

export interface BuildRlusdPaymentTxOpts {
  /** Buyer (signer) classic address. */
  fromAddress: string;
  /** Merchant classic address from the challenge. */
  payTo: string;
  /** Decimal RLUSD amount string (e.g. "0.01"). */
  amount: string;
  /** RLUSD issuer for the target network. */
  issuer: string;
  /** Invoice ID — bound into MemoData (hex(UTF-8(invoiceId))). */
  invoiceId: string;
  /** SourceTag stamp. @default DEFAULT_SOURCE_TAG (T54 indexer tag). */
  sourceTag?: number;
  /** Optional XRPL DestinationTag echoed from challenge.extra.destinationTag. */
  destinationTag?: number;
  /** LastLedgerSequence padding (in ledgers) past current. @default 20 (~80s). */
  lastLedgerOffset?: number;
}

/**
 * Build a *ready-to-sign* XRPL `Payment` transaction that satisfies the T54
 * exact-scheme verifier:
 *
 *   - TransactionType=Payment, IOU Amount with currency+issuer+value
 *   - SourceTag (default 804681468) so x402scan indexes it
 *   - Memos[0].MemoData = hex(UTF-8(invoiceId)) for invoice binding
 *   - LastLedgerSequence set to current+offset for bounded expiry
 *
 * No I/O beyond `connection.autofill` (single round-trip). The caller is
 * responsible for `wallet.sign(tx)` to produce the `signedTxBlob`.
 *
 * SOLID — SRP: builds one tx; no HTTP, no wire format, no signing.
 */
export async function buildXrplRlusdPaymentTx(
  connection: XrplConnection,
  opts: BuildRlusdPaymentTxOpts,
): Promise<Record<string, unknown>> {
  const {
    fromAddress,
    payTo,
    amount,
    issuer,
    invoiceId,
    sourceTag = DEFAULT_SOURCE_TAG,
    destinationTag,
    lastLedgerOffset = DEFAULT_LAST_LEDGER_OFFSET,
  } = opts;

  if (!fromAddress?.startsWith('r')) throw bad('fromAddress must be an XRPL classic address');
  if (!payTo?.startsWith('r')) throw bad('payTo must be an XRPL classic address');
  if (!issuer?.startsWith('r')) throw bad('issuer must be an XRPL classic address');
  if (!amount) throw bad('amount required');

  const memo = hexInvoiceMemo(invoiceId); // throws on oversize / empty

  // T54 IOU policy: the Payment must include `SendMax` with the same
  // currency + issuer + value as `Amount` so the Payment is locked to a
  // same-asset direct transfer (no cross-currency / AMM hops). Without it
  // the facilitator rejects the tx with
  // `invalidReason="unsupported_payment_features"` (see x402-xrpl@0.2.0
  // client/presigned_payment_payer.py L202-L207).
  const iouAmount = { currency: RLUSD_CURRENCY, issuer, value: amount };

  const draft: Record<string, unknown> = {
    TransactionType: 'Payment',
    Account: fromAddress,
    Destination: payTo,
    Amount: iouAmount,
    SendMax: iouAmount,
    SourceTag: sourceTag,
    Memos: [memo],
  };
  if (typeof destinationTag === 'number') draft.DestinationTag = destinationTag;

  const client = await connection.getClient();
  // `autofill` populates Sequence, Fee, and LastLedgerSequence from the
  // connected ledger. We then extend LastLedgerSequence by `lastLedgerOffset`
  // so the facilitator has time to submit before expiry.
  const filled: Record<string, unknown> = await client.autofill(draft);
  const baseLls = (filled.LastLedgerSequence as number | undefined) ?? 0;
  filled.LastLedgerSequence = baseLls + lastLedgerOffset;
  return filled;
}

function bad(msg: string): NPaymentError {
  return new NPaymentError(`Invalid XRPL Payment input: ${msg}`, 'XRPL_INVALID_PAYMENT_INPUT');
}
