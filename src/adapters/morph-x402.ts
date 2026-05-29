import type { PaymentAdapter, PaymentContext, ChainKey } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { MorphX402Client } from '../morph/client.js';
import { CHAINS } from '../chains.js';
import { ChallengeParseError, InsufficientBalanceError, NPaymentError } from '../errors.js';
import {
  buildTransferWithAuthorizationTypedData,
  encodeAuthorizationPayload,
  randomEip3009Nonce,
} from '../morph/eip3009.js';

/**
 * Morph x402 adapter — single responsibility: orchestrate the Morph payment flow.
 *
 * Two schemes, dispatched by the `scheme` field in the 402 challenge envelope:
 *
 *  • `'exact'` (default, Morph mainnet behavior unchanged):
 *      verify → wallet.transferERC20 → settle(txHash) → retry
 *
 *  • `'eip3009'` (Hoodi sponsored, v0.18):
 *      sign EIP-712 TransferWithAuthorization → settle({authorization,signature})
 *      facilitator submits on-chain (sponsor pays gas) → retry
 *
 * Routing: chain-config-driven (detect() inspects the 402 network field).
 */
export class MorphX402Adapter implements PaymentAdapter {
  readonly protocol = 'morph-x402';

  constructor(
    private readonly wallet: OWSWallet,
    private readonly client: MorphX402Client,
    private readonly chainKey: ChainKey,
  ) {}

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const network = decoded?.accepts?.[0]?.network as string | undefined;
      return network === CHAINS[this.chainKey].caip2;
    } catch {
      return false;
    }
  }

  async pay(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    ctx?: PaymentContext,
  ): Promise<Response> {
    const requirements = this.parseRequirements(response);
    const chain = CHAINS[this.chainKey];
    const asset = (requirements.asset || chain.tokens.USDC) as `0x${string}`;
    const amount = BigInt(requirements.maxAmountRequired);

    // Common pre-check: buyer must hold enough USDC. (Sponsor pays gas in eip3009 mode,
    // but the contract still pulls from the buyer — fail fast either way.)
    const balance = await this.wallet.getBalance(asset, chain.chainId);
    if (balance < amount) {
      throw new InsufficientBalanceError(
        `Insufficient ${asset} on ${chain.name}: have ${balance}, need ${amount}`,
        'INSUFFICIENT_BALANCE',
        `Fund wallet on ${chain.name} (chainId ${chain.chainId})`,
      );
    }

    const settleRes = requirements.scheme === 'eip3009'
      ? await this.paySponsored(requirements, asset, amount, chain.chainId)
      : await this.payDirect(requirements, asset, amount, chain.chainId);

    return this.retryWithProof(url, init, settleRes, chain.caip2, ctx);
  }

  // ── Scheme: 'exact' (legacy, Morph mainnet) ───────────────────────────────

  private async payDirect(
    requirements: ParsedRequirements,
    asset: `0x${string}`,
    amount: bigint,
    chainId: number,
  ): Promise<SettleOutcome> {
    const fromAddress = await this.wallet.getAddressAsync(chainId);
    const payload = {
      x402Version: 2,
      scheme: requirements.scheme,
      network: requirements.network,
      payload: { from: fromAddress, to: requirements.payTo, amount: amount.toString(), asset },
    };
    const verifyRes = await this.client.verify(payload, requirements.raw);
    if (!verifyRes.isValid) {
      throw new NPaymentError(
        `Morph verify rejected payment: ${verifyRes.invalidReason ?? 'unknown'}`,
        'MORPH_VERIFY_FAILED',
      );
    }

    const { txHash } = await this.wallet.transferERC20(requirements.payTo, asset, amount, chainId);

    const settledPayload = { ...payload, payload: { ...payload.payload, transaction: txHash } };
    const settleRes = await this.client.settle(settledPayload, requirements.raw);
    if (!settleRes.success) {
      throw new NPaymentError(
        `Morph settle failed (tx ${txHash}): ${settleRes.errorReason ?? 'unknown'}`,
        'MORPH_SETTLE_FAILED',
        'Payment was sent on-chain but facilitator did not confirm. Retry with same tx hash.',
      );
    }
    return { txHash: settleRes.transaction ?? txHash, payer: settleRes.payer, network: settleRes.network };
  }

  // ── Scheme: 'eip3009' (Hoodi sponsored, v0.18) ────────────────────────────

  private async paySponsored(
    requirements: ParsedRequirements,
    asset: `0x${string}`,
    amount: bigint,
    chainId: number,
  ): Promise<SettleOutcome> {
    const fromAddress = (await this.wallet.getAddressAsync(chainId)) as `0x${string}`;
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: fromAddress,
      to: requirements.payTo as `0x${string}`,
      value: amount,
      validAfter: 0n,
      validBefore: BigInt(now + 300), // 5 min window
      nonce: randomEip3009Nonce(),
    };
    const td = buildTransferWithAuthorizationTypedData({
      verifyingContract: asset, chainId, authorization,
    });
    const signature = await this.wallet.signTypedData({
      domain: td.domain, types: td.types, primaryType: 'TransferWithAuthorization',
      message: td.message as unknown as Record<string, unknown>,
    });
    const payload = {
      x402Version: 2,
      scheme: 'eip3009',
      network: requirements.network,
      payload: { authorization: encodeAuthorizationPayload(authorization), signature },
    };

    const verifyRes = await this.client.verify(payload, requirements.raw);
    if (!verifyRes.isValid) {
      throw new NPaymentError(
        `Morph verify rejected payment: ${verifyRes.invalidReason ?? 'unknown'}`,
        'MORPH_VERIFY_FAILED',
      );
    }
    const settleRes = await this.client.settle(payload, requirements.raw);
    if (!settleRes.success) {
      throw new NPaymentError(
        `Morph settle failed: ${settleRes.errorReason ?? 'unknown'}`,
        'MORPH_SETTLE_FAILED',
        'Sponsor failed to submit transferWithAuthorization. Refresh nonce and retry.',
      );
    }
    if (!settleRes.transaction) {
      throw new NPaymentError('Morph settle returned no transaction hash', 'MORPH_SETTLE_NO_TX');
    }
    return { txHash: settleRes.transaction, payer: settleRes.payer ?? fromAddress, network: settleRes.network };
  }

  // ── Shared retry-with-proof step ──────────────────────────────────────────

  private async retryWithProof(
    url: string,
    init: RequestInit | undefined,
    out: SettleOutcome,
    fallbackNetwork: string,
    ctx?: PaymentContext,
  ): Promise<Response> {
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-tx', out.txHash);
    retryHeaders.set('x-payment-network', out.network ?? fallbackNetwork);
    if (out.payer) retryHeaders.set('x-payment-payer', out.payer);
    if (ctx?.referenceKey) retryHeaders.set('x-payment-reference-key', ctx.referenceKey);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  // ── Challenge parsing ─────────────────────────────────────────────────────

  private parseRequirements(response: Response): ParsedRequirements {
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) {
      throw new ChallengeParseError('Missing payment-required header', 'MORPH_NO_CHALLENGE');
    }
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const accepts = decoded?.accepts?.[0];
      if (!accepts?.payTo || !accepts?.maxAmountRequired) {
        throw new Error('challenge missing payTo or maxAmountRequired');
      }
      return {
        scheme: String(accepts.scheme ?? 'exact'),
        network: String(accepts.network),
        asset: String(accepts.asset ?? ''),
        maxAmountRequired: String(accepts.maxAmountRequired),
        payTo: String(accepts.payTo),
        raw: accepts,
      };
    } catch (err) {
      throw new ChallengeParseError(
        `Invalid Morph payment-required header: ${(err as Error).message}`,
        'MORPH_BAD_CHALLENGE',
      );
    }
  }
}

interface ParsedRequirements {
  scheme: string;
  network: string;
  asset: string;
  maxAmountRequired: string;
  payTo: string;
  raw: unknown;
}

interface SettleOutcome {
  txHash: string;
  payer?: string;
  network?: string;
}
