import { ChallengeParseError, NPaymentError } from '../errors.js';
import type { InitiaClient } from '../initia/client.js';
import type { InitiaChainKey } from '../initia/types.js';
import type { PaymentAdapter, PaymentContext } from '../types.js';

/**
 * Bridge orchestrator hook — invoked by the adapter when the configured Initia
 * wallet is short of iUSD. Wired by PaymentClient (Task 6) to compose the Skip
 * API / LayerZero / Wormhole-NTT-fallback corridor; left undefined in standalone
 * tests so the adapter throws an explicit `INITIA_IUSD_INSUFFICIENT` instead of
 * silently failing.
 */
export type IusdBridgeIfNeeded = (req: {
  requiredAmount: bigint;
  recipient: string;
}) => Promise<bigint>;

export interface InitiaIusdAdapterOptions {
  bridgeIfNeeded?: IusdBridgeIfNeeded;
}

interface CosmosMsgSendChallenge {
  scheme: 'cosmos-msgsend';
  network: string;            // cosmos chain-id ('interwoven-1' / 'initiation-2')
  asset: string;              // 'iUSD' (or denom string)
  payTo: string;              // bech32 init1...
  maxAmountRequired: string;  // base-unit decimal string (6 decimals)
  memo?: string;
}

/**
 * v0.23 — `cosmos-msgsend` 402 adapter for iUSD on Initia.
 *
 * Flow:  parse challenge → ensure liquidity (optional bridge hook) →
 *        MsgSend iUSD → encode tx-hash proof in `x-payment` → retry HTTP.
 *
 * SOLID:
 *   SRP — owns the 402 challenge round-trip for cosmos-msgsend, nothing else.
 *   DIP — depends on `InitiaClient` abstraction + injected bridge hook.
 *   OCP — bridge orchestration is a function-typed strategy, swappable per-instance.
 */
export class InitiaIusdAdapter implements PaymentAdapter {
  readonly protocol = 'cosmos-msgsend';
  private bridgeHook?: IusdBridgeIfNeeded;

  constructor(
    private readonly initia: InitiaClient,
    private readonly chainKey: InitiaChainKey,
    options: InitiaIusdAdapterOptions = {},
  ) {
    this.bridgeHook = options.bridgeIfNeeded;
  }

  /**
   * Late-bind the bridge orchestrator. Called by PaymentClient consumers after
   * construction (the orchestrator depends on async-resolvable config and on
   * the adapter being already-registered, hence the setter pattern).
   */
  setBridgeIfNeeded(hook: IusdBridgeIfNeeded | undefined): void {
    this.bridgeHook = hook;
  }

  detect(response: Response): boolean {
    const header =
      response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      return decoded?.accepts?.[0]?.scheme === 'cosmos-msgsend';
    } catch {
      return false;
    }
  }

  async pay(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    _ctx?: PaymentContext,
  ): Promise<Response> {
    const challenge = this.parseChallenge(response);
    const amount = BigInt(challenge.maxAmountRequired);
    const recipient = await this.initia.getAddress();

    // 1. Ensure liquidity on the destination Initia chain.
    const balance = await this.initia.getIusdBalance();
    if (balance < amount) {
      if (!this.bridgeHook) {
        throw new NPaymentError(
          `Insufficient iUSD on ${this.chainKey}: have=${balance}, need=${amount}`,
          'INITIA_IUSD_INSUFFICIENT',
          'Fund the wallet with iUSD on Initia, or wire a bridge corridor via PaymentClient.',
        );
      }
      const post = await this.bridgeHook({ requiredAmount: amount, recipient });
      if (post < amount) {
        throw new NPaymentError(
          `Bridge completed but iUSD still short: have=${post}, need=${amount}`,
          'INITIA_IUSD_BRIDGE_INSUFFICIENT',
        );
      }
    }

    // 2. Broadcast bank.MsgSend.
    const result = await this.initia.sendIusd(challenge.payTo, amount, challenge.memo);

    // 3. Encode payment proof and retry the original request.
    const proof = Buffer.from(
      JSON.stringify({
        scheme: 'cosmos-msgsend',
        network: challenge.network,
        txHash: result.txHash,
        from: recipient,
        to: challenge.payTo,
        value: challenge.maxAmountRequired,
        asset: challenge.asset,
        memo: challenge.memo,
      }),
    ).toString('base64');

    const headers = new Headers(init?.headers);
    headers.set('x-payment', proof);
    return fetch(url, { ...init, headers });
  }

  private parseChallenge(response: Response): CosmosMsgSendChallenge {
    const header =
      response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
    if (!header) {
      throw new ChallengeParseError('Missing payment-required header', 'MISSING_HEADER');
    }
    let decoded: { accepts?: CosmosMsgSendChallenge[] };
    try {
      decoded = JSON.parse(Buffer.from(header, 'base64').toString());
    } catch {
      throw new ChallengeParseError(
        'Malformed payment-required header (not base64 JSON)',
        'INVALID_HEADER',
      );
    }
    const accept = decoded.accepts?.[0];
    if (!accept || accept.scheme !== 'cosmos-msgsend') {
      throw new ChallengeParseError('Challenge is not cosmos-msgsend', 'INVALID_SCHEME');
    }
    if (!accept.payTo || !accept.maxAmountRequired) {
      throw new ChallengeParseError(
        'Missing payTo or maxAmountRequired in cosmos-msgsend challenge',
        'INVALID_CHALLENGE',
      );
    }
    return accept;
  }
}
