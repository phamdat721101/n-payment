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
import { createPublicClient, http, type Address } from 'viem';

/** v0.20: Optional EIP-712 domain overrides for sponsored mode (eip3009). */
export interface MorphX402AdapterOptions {
  tokenName?: string;
  tokenVersion?: string;
}

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
 *  v0.20: paySponsored() now resolves the EIP-712 `name`/`version` from the
 *  USDC contract on-chain when overrides are not supplied. This fixes the
 *  Hoodi USDC mismatch (name=`'USDC'`) without breaking mainnet behavior.
 *
 * Routing: chain-config-driven (detect() inspects the 402 network field).
 */
export class MorphX402Adapter implements PaymentAdapter {
  readonly protocol = 'morph-x402';

  /** Cache of resolved EIP-712 domain per asset address (string keyed for simplicity). */
  private domainCache = new Map<string, { name: string; version: string }>();

  constructor(
    private readonly wallet: OWSWallet,
    private readonly client: MorphX402Client,
    private readonly chainKey: ChainKey,
    private readonly opts: MorphX402AdapterOptions = {},
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
    // v0.20: resolve EIP-712 domain (name/version) for the asset. Hoodi USDC uses
    // name='USDC' (not Circle's mainnet 'USD Coin'); resolving on-chain is the
    // robust default. Caller may bypass via MorphConfig.tokenName/tokenVersion.
    const dom = await this.resolveEip712Domain(asset, chainId);
    const td = buildTransferWithAuthorizationTypedData({
      verifyingContract: asset, chainId, authorization,
      tokenName: dom.name, tokenVersion: dom.version,
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

  /**
   * v0.20: Resolve the EIP-712 domain `name`/`version` for an ERC-20 asset.
   * Resolution order:
   *   1. Constructor opts.tokenName / opts.tokenVersion (caller override).
   *   2. On-chain `name()` / `version()` reads against the chain's RPC.
   *   3. Fallback to Circle FiatTokenV2 defaults: 'USD Coin' / '2'.
   * Cached per asset address for the adapter lifetime.
   */
  private async resolveEip712Domain(
    asset: `0x${string}`,
    chainId: number,
  ): Promise<{ name: string; version: string }> {
    const cacheKey = asset.toLowerCase();
    const cached = this.domainCache.get(cacheKey);
    if (cached) return cached;

    let name = this.opts.tokenName;
    let version = this.opts.tokenVersion;

    if (!name || !version) {
      const chain = CHAINS[this.chainKey];
      try {
        const pub = createPublicClient({ transport: http(chain.rpcUrl) });
        const erc20Meta = [
          { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
          { name: 'version', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
        ] as const;
        if (!name) {
          name = (await pub.readContract({
            address: asset, abi: erc20Meta, functionName: 'name',
          })) as string;
        }
        if (!version) {
          try {
            version = (await pub.readContract({
              address: asset, abi: erc20Meta, functionName: 'version',
            })) as string;
          } catch {
            version = '2';
          }
        }
      } catch {
        // Network or contract read failure — fall back to Circle defaults.
        name = name ?? 'USD Coin';
        version = version ?? '2';
      }
    }
    const resolved = { name: name ?? 'USD Coin', version: version ?? '2' };
    this.domainCache.set(cacheKey, resolved);
    void chainId; // referenced for symmetry; pub uses chain.rpcUrl directly.
    return resolved;
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
