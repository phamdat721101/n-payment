/**
 * v0.25 — Celo CIP-64 fee-abstracted x402 adapter.
 *
 * Buyer side  : delegates to the canonical `X402Adapter` (off-chain EIP-3009
 *               signing — no transaction broadcast, no gas needed). The
 *               buyer's wallet only needs USDC/USDT/USDm (no CELO).
 * Merchant side: `verifyAndSettle` broadcasts `transferWithAuthorization` on
 *               the Celo USDC contract, wrapped in `CeloFeeAbstractedTransactor`
 *               so the FACILITATOR wallet also pays gas in USDC (zero CELO).
 *
 * SOLID — Single Responsibility: this adapter is the integration seam between
 * the existing x402 wire format and Celo's CIP-64 primitive. All raw EIP-3009
 * signing logic stays in `X402Adapter`; all CIP-64 logic stays in the
 * transactor. This file just wires them together.
 */
import type { Address, Hex } from 'viem';
import type { OWSWallet } from '../ows/wallet.js';
import type { ChainKey, PaymentAdapter, PaymentContext, CeloConfig } from '../types.js';
import { X402Adapter } from './x402.js';
import { CeloFeeAbstractedTransactor, type CeloChainKey } from '../celo/fee-abstraction.js';
import { ChallengeParseError, NPaymentError } from '../errors.js';
import { CHAINS } from '../chains.js';

/** EIP-3009 authorization payload as carried in an x402 v2 envelope. */
export interface CeloEip3009Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

/** Result of a merchant-side `verifyAndSettle`. */
export interface CeloSettleResult {
  txHash: Hex;
  blockNumber: bigint;
  settledAt: number;
  feeCurrency: Address | undefined;
}

export class CeloFeeAbstractedAdapter implements PaymentAdapter {
  readonly protocol = 'celo-fee-abstracted';
  private readonly inner: X402Adapter;
  private transactor?: CeloFeeAbstractedTransactor;
  private readonly chainKey: CeloChainKey;
  private readonly config: CeloConfig;

  constructor(
    wallet: OWSWallet,
    chainKey: CeloChainKey,
    config: CeloConfig = {},
    validityWindowSeconds = 600,
  ) {
    this.chainKey = chainKey;
    this.config = config;
    // Buyer adapter: standard x402 EIP-3009 signing — viem-only, no broadcast,
    // so the buyer's wallet only needs USDC and never needs CELO.
    this.inner = new X402Adapter(wallet, chainKey as ChainKey, validityWindowSeconds);
    // Merchant transactor is opt-in via setMerchantSigner — keeps the
    // facilitator privateKey separate from the buyer's OWSWallet identity.
  }

  /**
   * Wire the merchant-side facilitator signing key. Called by `PaymentClient`
   * (or directly by integrators running their own facilitator) — keeps the
   * raw private key out of OWSWallet and lets a single n-payment instance
   * act as both buyer (OWSWallet.privateKey) and merchant (a separate
   * facilitator key) on Celo.
   */
  setMerchantSigner(facilitatorPrivateKey: Hex, payAsset: 'USDC' | 'USDT' | 'USDm' = 'USDC'): void {
    this.transactor = new CeloFeeAbstractedTransactor(
      facilitatorPrivateKey,
      this.chainKey,
      payAsset,
      {
        adapterOverride: this.config.feeCurrencyAdapterOverride,
        disabled: this.config.disableFeeAbstraction,
        rpcUrl: this.config.rpcUrl,
      },
    );
  }

  detect(response: Response): boolean {
    return this.inner.detect(response);
  }

  async pay(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    _ctx?: PaymentContext,
  ): Promise<Response> {
    // Buyer flow is identical to X402Adapter — no on-chain write, no gas needed.
    return this.inner.pay(url, init, response);
  }

  /**
   * Merchant-side: verify a buyer's EIP-3009 authorization (decoded from the
   * x-payment header), then broadcast `transferWithAuthorization` on the
   * USDC contract with the facilitator paying gas in USDC via CIP-64.
   */
  async verifyAndSettle(input: {
    authorization: CeloEip3009Authorization;
    signature: Hex;
    /** Override the asset contract (default: chain's USDC). */
    token?: Address;
  }): Promise<CeloSettleResult> {
    if (!this.transactor) {
      throw new NPaymentError(
        'Merchant signer not wired — call setMerchantSigner(facilitatorPrivateKey) first',
        'CELO_NO_MERCHANT_SIGNER',
        'Pass the facilitator privateKey via CeloFeeAbstractedAdapter.setMerchantSigner().',
      );
    }
    const token = input.token ?? (CHAINS[this.chainKey].tokens.USDC as Address);
    if (!token) {
      throw new NPaymentError(
        `No USDC asset registered on ${this.chainKey}`,
        'CELO_FEE_ABSTRACTION_REJECTED',
      );
    }
    const { txHash, blockNumber } = await this.transactor.transferWithAuthorization({
      token,
      from: input.authorization.from,
      to: input.authorization.to,
      value: input.authorization.value,
      validAfter: input.authorization.validAfter,
      validBefore: input.authorization.validBefore,
      nonce: input.authorization.nonce,
      signature: input.signature,
    });
    return {
      txHash,
      blockNumber,
      settledAt: Date.now(),
      feeCurrency: this.transactor.getFeeCurrency(),
    };
  }

  /**
   * Decode the x-payment header from a buyer's retry request. Helper for
   * merchants who receive the header server-side and want a typed payload.
   */
  static decodeXPayment(headerB64: string): {
    authorization: CeloEip3009Authorization;
    signature: Hex;
    network: string;
  } {
    let envelope: {
      payload?: {
        signature?: Hex;
        authorization?: {
          from: Address; to: Address; value: string;
          validAfter: string; validBefore: string; nonce: Hex;
        };
      };
      network?: string;
    };
    try {
      envelope = JSON.parse(Buffer.from(headerB64, 'base64').toString());
    } catch {
      throw new ChallengeParseError('Malformed x-payment header', 'INVALID_HEADER');
    }
    const auth = envelope.payload?.authorization;
    const sig = envelope.payload?.signature;
    if (!auth || !sig) {
      throw new ChallengeParseError('Missing authorization or signature in x-payment', 'INVALID_HEADER');
    }
    return {
      authorization: {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature: sig,
      network: envelope.network ?? '',
    };
  }
}
