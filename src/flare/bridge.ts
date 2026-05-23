import type { Address } from 'viem';
import { NPaymentError } from '../errors.js';
import type { XrplConnection } from '../xrpl/connection.js';
import type { XrplWallet } from '../xrpl/wallet.js';
import {
  computeDirectMintingQuote,
  encodeDirectMintingMemo32,
  formatXrpDropsAmount,
  getDirectMintingFees,
  getDirectMintingPaymentAddress,
  parseXrpDropsAmount,
  preflightDirectMintingLimits,
  toXrplMemoHex,
  type DirectMintingFees,
  type DirectMintingPreflight,
} from './direct-minting.js';
import { getPersonalAccountAddress } from './state.js';
import type { FlareClient } from './client.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface FlareBridgeConfig {
  flare: FlareClient;
  xrplWallet: XrplWallet;
  xrplConnection: XrplConnection;
}

export interface FlareMintParams {
  /** Net XRP amount to mint as FXRP, decimal string up to 6 places. */
  amountXrp: string;
}

export interface FlareMintReceipt {
  /** XRPL transaction hash of the validated Payment to the Core Vault. */
  xrplTxHash: string;
  xrplValidated: boolean;
  /** Gross XRP paid (net mint + fees), decimal string. */
  paymentXrp: string;
  /** Expected net FXRP credited to the PersonalAccount, decimal string. */
  netFxrp: string;
  fees: {
    proportionalUBA: bigint;
    minFeeUBA: bigint;
    mintingFeeUBA: bigint;
    executorFeeUBA: bigint;
  };
  recipientPersonalAccount: Address;
  coreVaultXrplAddress: string;
  rateLimit: DirectMintingPreflight;
}

// ─── Bridge client ───────────────────────────────────────────────────────────

/**
 * v0.15 FXRP direct-minting bridge orchestrator.
 *
 * `mintFXRP({ amountXrp })`:
 *   1. resolves PersonalAccount + fees + Core Vault in parallel,
 *   2. computes the gross XRP payment,
 *   3. encodes the 32-byte memo (recipient = PersonalAccount),
 *   4. submits a single XRPL Payment to the Core Vault,
 *   5. returns the validated tx hash + fee breakdown.
 *
 * Submit-and-return: caller polls `getFxrpBalance(personalAccount)` for confirmation.
 * Per-wallet mutex serialises concurrent calls so the XRPL sequence number never races.
 */
export class FlareBridgeClient {
  /** Per-XRPL-address mutex — fixes concurrent double-submit on the same wallet. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: FlareBridgeConfig) {}

  async mintFXRP(params: FlareMintParams): Promise<FlareMintReceipt> {
    const xrplAddress = await this.deps.xrplWallet.getAddress();
    const previous = this.locks.get(xrplAddress) ?? Promise.resolve();
    const work = previous.then(
      () => this.mintLocked(xrplAddress, params),
      () => this.mintLocked(xrplAddress, params),
    );
    this.locks.set(xrplAddress, work);
    try {
      return (await work) as FlareMintReceipt;
    } finally {
      if (this.locks.get(xrplAddress) === work) this.locks.delete(xrplAddress);
    }
  }

  private async mintLocked(
    xrplAddress: string,
    params: FlareMintParams,
  ): Promise<FlareMintReceipt> {
    // 1. Validate amount up-front (throws FLARE_INVALID_AMOUNT on bad input).
    parseXrpDropsAmount(params.amountXrp);

    // 2. Parallel preflight reads: PersonalAccount, fees, Core Vault.
    const [personalAccount, fees, coreVaultXrplAddress] = await Promise.all([
      getPersonalAccountAddress(this.deps.flare, xrplAddress),
      getDirectMintingFees(this.deps.flare),
      getDirectMintingPaymentAddress(this.deps.flare),
    ]);

    // 3. Compute gross payment + rate-limit preflight.
    const quote = computeDirectMintingQuote(params.amountXrp, fees);
    const rateLimit = await preflightDirectMintingLimits(this.deps.flare, quote.totalUBA);
    if (rateLimit.large) {
      console.warn(
        `[n-payment][flare] Mint of ${quote.paymentXrp} XRP is above the protocol's large-mint ` +
          `threshold (${formatXrpDropsAmount(rateLimit.largeThresholdUBA ?? 0n)} XRP) — ` +
          `it will be delayed by the executor. Watch for DirectMintingDelayed events on Coston2.`,
      );
    }

    // 4. Encode the 32-byte memo (recipient = PersonalAccount).
    const memoHex = toXrplMemoHex(encodeDirectMintingMemo32(personalAccount));

    // 5. Sign and submit a single XRPL Payment.
    const txHash = await this.submitXrplPayment({
      from: xrplAddress,
      to: coreVaultXrplAddress,
      paymentXrp: quote.paymentXrp,
      memoHex,
    });

    return {
      xrplTxHash: txHash.hash,
      xrplValidated: txHash.validated,
      paymentXrp: quote.paymentXrp,
      netFxrp: quote.netFxrp,
      fees: {
        proportionalUBA: quote.proportionalFeeUBA,
        minFeeUBA: fees.minFeeUBA,
        mintingFeeUBA: quote.mintingFeeUBA,
        executorFeeUBA: quote.executorFeeUBA,
      },
      recipientPersonalAccount: personalAccount,
      coreVaultXrplAddress,
      rateLimit,
    };
  }

  /**
   * Submit the XRPL Payment carrying the direct-minting memo.
   * Maps non-tesSUCCESS engine results to FLARE_BRIDGE_SUBMIT_FAILED with the tx hash.
   */
  private async submitXrplPayment(args: {
    from: string;
    to: string;
    paymentXrp: string;
    memoHex: string;
  }): Promise<{ hash: string; validated: boolean }> {
    const client = await this.deps.xrplConnection.getClient();
    const drops = parseXrpDropsAmount(args.paymentXrp).toString();

    const tx: Record<string, unknown> = {
      TransactionType: 'Payment',
      Account: args.from,
      Destination: args.to,
      Amount: drops,
      Memos: [{ Memo: { MemoData: args.memoHex } }],
    };

    const prepared = await client.autofill(tx);
    const signed = await this.deps.xrplWallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);

    const engine =
      result.result?.meta?.TransactionResult ?? result.result?.engine_result;
    if (engine && engine !== 'tesSUCCESS') {
      throw new NPaymentError(
        `Flare bridge submit failed: ${engine}`,
        'FLARE_BRIDGE_SUBMIT_FAILED',
        `Inspect XRPL tx ${result.result?.hash} on a testnet explorer; the executor never picked it up.`,
      );
    }

    return {
      hash: result.result?.hash ?? '',
      validated: result.result?.validated ?? false,
    };
  }
}

export function createFlareBridgeClient(config: FlareBridgeConfig): FlareBridgeClient {
  return new FlareBridgeClient(config);
}

// Re-export the DirectMintingFees type so callers can build their own quotes.
export type { DirectMintingFees };
