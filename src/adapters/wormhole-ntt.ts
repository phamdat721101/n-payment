import { NPaymentError } from '../errors.js';
import type { ChainKey, PaymentAdapter, PaymentContext } from '../types.js';
import { RLUSD_NTT_DEPLOYMENTS, whChainFromKey } from '../wormhole/deployments.js';
import type { WormholeNttClient } from '../wormhole/ntt-client.js';
import type { NttTransferReceipt, WormholeNttAdapterOptions } from '../wormhole/types.js';

/**
 * v0.22 — Wormhole NTT bridge-then-pay adapter.
 *
 * Used internally by PayRouter v3 (PRD-C) when an x402 challenge requires RLUSD
 * on chain X and the buyer holds RLUSD on chain Y. Bridges Y → X via Wormhole
 * NTT, then defers the actual 402 settlement to the chain-X adapter
 * (RlusdExactAdapter from PRD-D).
 *
 * NOT a top-level adapter for direct 402 detection — `detect` returns false and
 * `pay` throws WORMHOLE_NTT_USE_PAYROUTER. The corridor is the only call-site.
 *
 * SOLID — SRP: cap enforcement + ChainKey↔WormholeChainName mapping + delegation.
 * The Wormhole protocol details live in WormholeNttClient.
 */
export class WormholeNttAdapter implements PaymentAdapter {
  readonly protocol = 'wormhole-ntt';
  private spentToday = 0n;
  private dayStart = Date.now();

  constructor(
    private readonly client: WormholeNttClient,
    private readonly opts: WormholeNttAdapterOptions = {},
  ) {}

  detect(_response: Response): boolean {
    return false;
  }

  async pay(
    _url: string,
    _init: RequestInit | undefined,
    _response: Response,
    _ctx?: PaymentContext,
  ): Promise<Response> {
    throw new NPaymentError(
      'WormholeNttAdapter is not a top-level adapter; the PayRouter v3 corridor invokes bridgeRlusd() directly.',
      'WORMHOLE_NTT_USE_PAYROUTER',
      'Configure chains: [...evm, "xrpl-mainnet"] and let fetchWithPayment route automatically.',
    );
  }

  /**
   * The actual public entry-point. Bridges RLUSD from `fromChain` to `toChain`
   * for the given `recipient`. Throws on cap violations or unsupported chain.
   */
  async bridgeRlusd(req: {
    fromChain: ChainKey;
    toChain: ChainKey;
    amount: bigint;
    recipient: `0x${string}`;
  }): Promise<NttTransferReceipt> {
    const from = whChainFromKey(req.fromChain);
    const to = whChainFromKey(req.toChain);
    if (!from || !to) {
      throw new NPaymentError(
        `Unsupported NTT chain: ${req.fromChain} → ${req.toChain}`,
        'WORMHOLE_NTT_CHAIN_UNSUPPORTED',
        `Supported: ${Object.keys(RLUSD_NTT_DEPLOYMENTS).join(', ')}`,
      );
    }
    this.assertCaps(req.amount);

    const receipt = await this.client.transfer({
      from,
      to,
      amount: req.amount,
      recipient: req.recipient,
    });
    this.spentToday += req.amount;
    return receipt;
  }

  private assertCaps(amount: bigint): void {
    const { maxPerTransfer, maxPerDay } = this.opts;
    if (maxPerTransfer !== undefined && amount > maxPerTransfer) {
      throw new NPaymentError(
        `Wormhole NTT max-per-transfer exceeded: ${amount} > ${maxPerTransfer}`,
        'WORMHOLE_NTT_MAX_PER_TRANSFER',
        'Lower the bridge amount or raise wormhole.maxPerTransfer in NPaymentConfig.',
      );
    }
    // Sliding 24h window — reset on day boundary.
    if (Date.now() - this.dayStart > 86_400_000) {
      this.dayStart = Date.now();
      this.spentToday = 0n;
    }
    if (maxPerDay !== undefined && this.spentToday + amount > maxPerDay) {
      throw new NPaymentError(
        `Wormhole NTT daily cap exceeded`,
        'WORMHOLE_NTT_DAILY_CAP',
        'Wait for the rolling 24h window to reset, or raise wormhole.maxPerDay.',
      );
    }
  }
}
