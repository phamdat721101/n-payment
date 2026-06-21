import { NPaymentError } from '../errors.js';
import type { XrplWallet } from './wallet.js';
import type { XrplConnection } from './connection.js';
import { invalidateAccountState } from './payments.js';
import {
  RLUSD_CURRENCY,
  parseRlusdAmount,
  padSendMaxDrops,
  type XrplNetwork,
} from './utils.js';

// ─── Public types ────────────────────────────────────────────────────────────

export type SwapAsset = 'XRP' | 'RLUSD';

export interface XrplSwapQuoteOptions {
  from: SwapAsset;
  to: SwapAsset;
  /** Exact RLUSD amount to deliver (decimal string, ≤ 6 places). */
  amountOut: string;
}

export interface XrplSwapQuote {
  /** Raw drops the source path will spend (un-padded). */
  sourceAmountDrops: bigint;
  /** Quote-time spot rate in drops-per-RLUSD-unit (6-dec micro-RLUSD). */
  spotRateDropsPerUnit: number;
  /** Pre-computed path array from rippled (passed verbatim into Payment.Paths). */
  paths: unknown[];
  /** Wall-clock ms after which the quote is considered stale. */
  validUntil: number;
}

export interface XrplSwapOptions extends XrplSwapQuoteOptions {
  /** Override the configured slippage cap (bps). */
  maxSlippageBps?: number;
  /** Re-use a fresh quote instead of re-fetching. Must satisfy validUntil. */
  quote?: XrplSwapQuote;
}

export interface XrplSwapResult {
  hash: string;
  amountInDrops: bigint;
  amountOut: string;
  effectiveRateDropsPerUnit: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const QUOTE_TTL_MS = 5_000;

// ─── Client ──────────────────────────────────────────────────────────────────

/**
 * Atomic XRP↔RLUSD swap via XRPL native cross-currency Payment.
 *
 * Strategy: rippled auto-routes through AMM + DEX in a single Payment tx.
 * `SendMax` (drops cap) is the slippage cap; `Amount` is exact-deliver RLUSD.
 * No `tfPartialPayment` flag (fail-closed semantics).
 */
export class XrplSwapClient {
  constructor(
    private readonly connection: XrplConnection,
    private readonly wallet: XrplWallet,
    private readonly network: XrplNetwork,
    private readonly issuer: string,
  ) {}

  /** Get a one-shot quote. Throws XRPL_NO_AMM_PATH when no path exists. */
  async quote(opts: XrplSwapQuoteOptions): Promise<XrplSwapQuote> {
    this.assertSupportedPair(opts);
    const amountOutUnits = parseRlusdAmount(opts.amountOut);

    const client = await this.connection.getClient();
    const address = await this.wallet.getAddress();
    const response = await client.request({
      command: 'ripple_path_find',
      source_account: address,
      destination_account: address,
      destination_amount: { currency: RLUSD_CURRENCY, issuer: this.issuer, value: opts.amountOut },
      source_currencies: [{ currency: 'XRP' }],
    });

    const alternatives = response.result?.alternatives;
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      throw new NPaymentError(
        `No XRP→RLUSD path on ${this.network}`,
        'XRPL_NO_AMM_PATH',
        'Fund the XRP/RLUSD AMM at xrpl.org/dex or pre-fund the wallet with RLUSD.',
      );
    }

    // Pick cheapest alternative by source_amount (drops, as string).
    const best = alternatives.reduce((a: { source_amount: string }, b: { source_amount: string }) =>
      BigInt(a.source_amount) <= BigInt(b.source_amount) ? a : b,
    ) as { source_amount: string; paths_computed?: unknown[] };

    const sourceAmountDrops = BigInt(best.source_amount);
    const spotRateDropsPerUnit = Number(sourceAmountDrops) / Number(amountOutUnits);

    return {
      sourceAmountDrops,
      spotRateDropsPerUnit,
      paths: best.paths_computed ?? [],
      validUntil: Date.now() + QUOTE_TTL_MS,
    };
  }

  /**
   * Execute the swap. Re-quotes unless a fresh `opts.quote` is provided.
   * Throws XRPL_QUOTE_STALE / XRPL_SLIPPAGE_EXCEEDED / XRPL_SWAP_FAILED.
   */
  async swap(opts: XrplSwapOptions): Promise<XrplSwapResult> {
    this.assertSupportedPair(opts);
    const slippageBps = opts.maxSlippageBps ?? 100;
    let quote = opts.quote;

    if (quote) {
      if (Date.now() > quote.validUntil) {
        throw new NPaymentError(
          'Quote expired',
          'XRPL_QUOTE_STALE',
          `Quote validUntil=${quote.validUntil} elapsed; re-fetch via swap.quote().`,
        );
      }
    } else {
      quote = await this.quote({ from: opts.from, to: opts.to, amountOut: opts.amountOut });
    }

    const sendMaxDrops = padSendMaxDrops(quote.sourceAmountDrops, slippageBps);

    const client = await this.connection.getClient();
    const address = await this.wallet.getAddress();
    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: address,
      Destination: address,
      Amount: { currency: RLUSD_CURRENCY, issuer: this.issuer, value: opts.amountOut },
      SendMax: sendMaxDrops.toString(),
    };
    if (quote.paths.length > 0) tx.Paths = quote.paths;

    const prepared = await client.autofill(tx);
    const signed = await this.wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    invalidateAccountState(address);

    const engine = result.result?.meta?.TransactionResult ?? result.result?.engine_result;
    if (engine && engine !== 'tesSUCCESS') {
      throw new NPaymentError(
        `XRPL swap failed: ${engine}`,
        'XRPL_SWAP_FAILED',
        engine === 'tecPATH_PARTIAL' || engine === 'tecPATH_DRY'
          ? 'Try a wider slippage cap or wait for AMM liquidity to recover.'
          : `Inspect tx ${result.result?.hash} on a XRPL explorer.`,
      );
    }

    return {
      hash: result.result.hash,
      amountInDrops: sendMaxDrops,
      amountOut: opts.amountOut,
      effectiveRateDropsPerUnit: quote.spotRateDropsPerUnit,
    };
  }

  private assertSupportedPair(opts: XrplSwapQuoteOptions): void {
    // Compare against the human-readable symbol — `opts.to` is the public
    // SwapAsset enum ('XRP' | 'RLUSD'), not a wire currency code.
    if (opts.from !== 'XRP' || opts.to !== 'RLUSD') {
      throw new NPaymentError(
        `Unsupported swap pair: ${opts.from}→${opts.to}`,
        'XRPL_UNSUPPORTED_PAIR',
        'v0.14 supports XRP→RLUSD only. Other pairs land in a future release.',
      );
    }
  }
}
