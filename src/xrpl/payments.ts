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

// ─── Trust-line bootstrap ────────────────────────────────────────────────────

export async function ensureTrustLine(
  connection: XrplConnection,
  wallet: XrplWallet,
  opts: IssuerOpts & { limit?: string },
): Promise<string | null> {
  const { issuer, currency = RLUSD_CURRENCY, limit = '1000000000' } = opts;
  const client = await connection.getClient();
  const address = await wallet.getAddress();

  const lines = await client.request({ command: 'account_lines', account: address });
  const exists = lines.result.lines?.some(
    (l: { currency: string; account: string }) => l.currency === currency && l.account === issuer,
  );
  if (exists) return null;

  const tx = await client.autofill({
    TransactionType: 'TrustSet',
    Account: address,
    LimitAmount: { currency, issuer, value: limit },
  });
  const signed = await wallet.sign(tx);
  const result = await client.submitAndWait(signed.tx_blob);
  return result.result.hash;
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

  const draft: Record<string, unknown> = {
    TransactionType: 'Payment',
    Account: fromAddress,
    Destination: payTo,
    Amount: { currency: RLUSD_CURRENCY, issuer, value: amount },
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
