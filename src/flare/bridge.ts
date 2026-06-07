import type { Address } from 'viem';
import { decodeEventLog } from 'viem';
import { NPaymentError } from '../errors.js';
import type { XrplConnection } from '../xrpl/connection.js';
import type { XrplWallet } from '../xrpl/wallet.js';
import { assetManagerAbi } from './abis.js';
import {
  computeDirectMintingQuote,
  computeRedemptionQuote,
  encodeDirectMintingMemo32,
  formatXrpDropsAmount,
  getDirectMintingFees,
  getDirectMintingPaymentAddress,
  getLotSize,
  getRedemptionFees,
  parseXrpDropsAmount,
  preflightDirectMintingLimits,
  toXrplMemoHex,
  type DirectMintingFees,
  type DirectMintingPreflight,
  type RedemptionFees,
  type RedemptionQuote,
} from './direct-minting.js';
import { getFxrpBalance, getPersonalAccountAddress } from './state.js';
import type { FlareClient } from './client.js';
import type { FlareGaslessForwarderClient, FlareGaslessExecuteResult } from './gasless.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface FlareBridgeConfig {
  flare: FlareClient;
  xrplWallet: XrplWallet;
  xrplConnection: XrplConnection;
  /** v0.19: optional dep that unlocks executeGaslessFxrpPayment(). */
  gaslessForwarder?: FlareGaslessForwarderClient;
  /**
   * v0.22.1: viem walletClient for redeemXRP() write calls. When omitted,
   * redeemXRP() throws FLARE_REDEEM_NO_WALLET_CLIENT.
   */
  walletClient?: import('viem').WalletClient;
  /** v0.22.1: caller's EVM address (Flare PersonalAccount) — used to filter logs. */
  flareAddress?: Address;
}

export interface FlareMintParams {
  /** Net XRP amount to mint as FXRP, decimal string up to 6 places. */
  amountXrp: string;
}

// ─── v0.22.1 — Redemption types ──────────────────────────────────────────────

export interface FlareRedeemParams {
  /** Net FXRP burned (decimal string ≤ 6 places). */
  amountFxrp: string;
  /** XRPL classic address that should receive the XRP. */
  xrplDestination: string;
  /** Optional executor address (defaults to zero — uses default executor). */
  executor?: Address;
}

export interface FlareRedeemReceipt {
  flareTxHash: `0x${string}`;
  requestId: bigint;
  expectedXrpReceived: string;
  fees: { redemptionFeeUBA: bigint; executorFeeUBA: bigint };
  /** Wall-clock submission time. */
  submittedAt: number;
}

export type FlareRedemptionStatus =
  | { kind: 'pending' }
  | { kind: 'performed'; xrplTxHash: `0x${string}`; performedAt: number }
  | { kind: 'failed'; reason: string };

export interface PollRedemptionOptions {
  /** Total wall-clock timeout (ms). Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Initial poll interval (ms). Default 5_000. Doubles on each backoff up to 30_000. */
  intervalMs?: number;
  /** Optional abort signal. */
  signal?: AbortSignal;
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
   * v0.22.1 — Redeem FXRP back to XRP on XRPL.
   *
   * Submit-and-return: writes `AssetManagerFXRP.redeem(lots, xrplDestination, executor)`,
   * parses the `RedemptionRequested` event for the requestId, returns a receipt.
   * Caller polls via {@link pollRedemption}.
   *
   * SOLID — SRP: only submission. Polling + status are separate methods.
   */
  async redeemXRP(params: FlareRedeemParams): Promise<FlareRedeemReceipt> {
    if (!this.deps.walletClient) {
      throw new NPaymentError(
        'FlareBridgeClient.redeemXRP requires walletClient on FlareBridgeConfig',
        'FLARE_REDEEM_NO_WALLET_CLIENT',
        'Pass walletClient (viem) when constructing FlareBridgeClient.',
      );
    }
    if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(params.xrplDestination)) {
      throw new NPaymentError(
        `Invalid XRPL destination address: ${params.xrplDestination}`,
        'FLARE_REDEEM_INVALID_XRPL_ADDRESS',
        'Pass a valid XRPL classic address (r-prefixed, base58).',
      );
    }

    // Preflight: balance + fees + lot-size.
    const flareAddress = this.deps.flareAddress
      ?? (this.deps.walletClient.account?.address as Address | undefined);
    if (!flareAddress) {
      throw new NPaymentError(
        'FlareBridgeClient.redeemXRP requires flareAddress (or walletClient.account.address)',
        'FLARE_REDEEM_NO_ADDRESS',
        'Pass flareAddress on FlareBridgeConfig or attach an account to walletClient.',
      );
    }

    const burnedFxrpUBA = parseXrpDropsAmount(params.amountFxrp);
    const [balance, fees, lotSize] = await Promise.all([
      getFxrpBalance(this.deps.flare, flareAddress),
      getRedemptionFees(this.deps.flare),
      getLotSize(this.deps.flare),
    ]);
    if (balance < burnedFxrpUBA) {
      throw new NPaymentError(
        `Insufficient FXRP for redemption: have ${balance}, need ${burnedFxrpUBA}`,
        'FLARE_REDEEM_INSUFFICIENT_FXRP',
        `Mint more FXRP via mintFXRP() or reduce the redemption amount.`,
      );
    }
    if (lotSize > 0n && burnedFxrpUBA % lotSize !== 0n) {
      throw new NPaymentError(
        `Redemption amount ${burnedFxrpUBA} not a multiple of lot size ${lotSize}`,
        'FLARE_REDEEM_NOT_LOT_MULTIPLE',
        `Redeem in multiples of ${formatXrpDropsAmount(lotSize)} FXRP.`,
      );
    }
    const lots = lotSize > 0n ? burnedFxrpUBA / lotSize : burnedFxrpUBA;
    const quote: RedemptionQuote = computeRedemptionQuote(params.amountFxrp, fees);

    // Submit redeem(lots, xrplDestination, executor).
    const assetManager = await this.deps.flare.registry.address('AssetManagerFXRP');
    const flareTxHash = (await this.deps.walletClient.writeContract({
      address: assetManager,
      abi: assetManagerAbi,
      functionName: 'redeem',
      args: [lots, params.xrplDestination, params.executor ?? '0x0000000000000000000000000000000000000000'],
      account: this.deps.walletClient.account!,
      chain: null,
    } as never)) as `0x${string}`;

    // Parse the RedemptionRequested event for requestId.
    const receipt = await this.deps.flare.publicClient.waitForTransactionReceipt({
      hash: flareTxHash,
    });
    const requestId = this.parseRedemptionRequestedId(receipt.logs);

    return {
      flareTxHash,
      requestId,
      expectedXrpReceived: quote.receivedXrp,
      fees: { redemptionFeeUBA: quote.redemptionFeeUBA, executorFeeUBA: quote.executorFeeUBA },
      submittedAt: Date.now(),
    };
  }

  /**
   * Read the on-chain status of a redemption request.
   * Scans the latest 5_000 blocks for RedemptionPerformed / RedemptionPaymentFailed events.
   * Returns 'pending' when no terminal event is found.
   */
  async getRedemptionStatus(
    requestId: bigint,
    fromBlock?: bigint,
  ): Promise<FlareRedemptionStatus> {
    const assetManager = await this.deps.flare.registry.address('AssetManagerFXRP');
    const tip = await this.deps.flare.publicClient.getBlockNumber();
    const startBlock = fromBlock ?? (tip > 5_000n ? tip - 5_000n : 0n);

    const logs = (await this.deps.flare.publicClient.getLogs({
      address: assetManager,
      events: assetManagerAbi.filter(
        (e) => e.type === 'event' && (e.name === 'RedemptionPerformed' || e.name === 'RedemptionPaymentFailed'),
      ) as never,
      fromBlock: startBlock,
      toBlock: tip,
    })) as Array<{ data: `0x${string}`; topics: readonly `0x${string}`[] }>;

    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: assetManagerAbi,
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        }) as {
          eventName: 'RedemptionPerformed' | 'RedemptionPaymentFailed';
          args: { requestId: bigint; transactionHash?: `0x${string}`; failureReason?: string };
        };
        if (decoded.args.requestId !== requestId) continue;
        if (decoded.eventName === 'RedemptionPerformed') {
          return {
            kind: 'performed',
            xrplTxHash: decoded.args.transactionHash!,
            performedAt: Date.now(),
          };
        }
        return { kind: 'failed', reason: decoded.args.failureReason ?? 'unknown' };
      } catch {
        continue;
      }
    }
    return { kind: 'pending' };
  }

  /**
   * Poll {@link getRedemptionStatus} with exponential backoff until the request
   * is terminal (performed/failed) or the timeout elapses.
   *
   * @throws FLARE_REDEMPTION_TIMEOUT if no terminal event before timeoutMs.
   * @throws FLARE_REDEMPTION_FAILED if executor reported a payment failure.
   */
  async pollRedemption(
    requestId: bigint,
    options: PollRedemptionOptions = {},
  ): Promise<{ xrplTxHash: `0x${string}` }> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    let interval = options.intervalMs ?? 5_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (options.signal?.aborted) {
        throw new NPaymentError(
          'Redemption poll aborted',
          'FLARE_REDEMPTION_ABORTED',
          'AbortSignal fired before terminal event.',
        );
      }
      const status = await this.getRedemptionStatus(requestId);
      if (status.kind === 'performed') return { xrplTxHash: status.xrplTxHash };
      if (status.kind === 'failed') {
        throw new NPaymentError(
          `Flare redemption failed: ${status.reason}`,
          'FLARE_REDEMPTION_FAILED',
          'The executor could not deliver XRP — call AssetManagerFXRP.redemptionPaymentDefault() to claim FXRP back.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(interval * 2, 30_000);
    }
    throw new NPaymentError(
      `Flare redemption timeout for request ${requestId}`,
      'FLARE_REDEMPTION_TIMEOUT',
      'Increase timeoutMs, or call AssetManagerFXRP.redemptionPaymentDefault() to claim FXRP back if the executor never delivers.',
    );
  }

  /** Parse a RedemptionRequested event from a tx receipt's log array. Throws if missing. */
  private parseRedemptionRequestedId(logs: readonly { topics: readonly string[]; data: string }[]): bigint {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: assetManagerAbi,
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        }) as { eventName: string; args: { requestId: bigint } };
        if (decoded.eventName === 'RedemptionRequested') return decoded.args.requestId;
      } catch {
        continue;
      }
    }
    throw new NPaymentError(
      'RedemptionRequested event not found in tx receipt',
      'FLARE_REDEEM_NO_REQUEST_EVENT',
      'Verify the call landed on the right chain + AssetManagerFXRP address. Inspect the tx on a Flare explorer.',
    );
  }

  /**
   * v0.19: send FXRP gaslessly via the GaslessPaymentForwarder relayer.
   * Requires `gaslessForwarder` to be passed in {@link FlareBridgeConfig}.
   * Caller must have done a one-time `gaslessForwarder.approve(MaxUint256)`
   * before the first payment.
   */
  async executeGaslessFxrpPayment(params: {
    to: Address;
    /** Raw FXRP units (drops/UBA). For human input, format via formatXrpDropsAmount. */
    amount: bigint;
    deadlineSeconds?: number;
  }): Promise<FlareGaslessExecuteResult> {
    if (!this.deps.gaslessForwarder) {
      throw new NPaymentError(
        'Gasless FXRP payments require gaslessForwarder dep on FlareBridgeConfig',
        'FLARE_GASLESS_NOT_CONFIGURED',
        'Construct FlareGaslessForwarderClient and pass it as gaslessForwarder — see examples/flare-payments-demo.ts.',
      );
    }
    return this.deps.gaslessForwarder.pay(params);
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
