import type { PaymentAdapter, PaymentContext, ChainKey } from '../types.js';
import type { StellarSigner } from '../stellar/signer.js';
import type { StellarChannelsClient } from '../stellar/channels-client.js';
import { CHAINS } from '../chains.js';
import { ChallengeParseError, NPaymentError } from '../errors.js';

/**
 * Stellar x402 adapter — wraps @x402/stellar's ExactStellarScheme.
 *
 * Single responsibility: orchestrate the Stellar x402 flow.
 *   1. Parse 402 → x402 v2 challenge
 *   2. (Optional) facilitator.verify() when apiKey present
 *   3. Build signed payment payload via @x402/stellar
 *   4. Retry with x-payment-signature + x-payment-network + x-payment-reference-key
 *
 * Routing: chain-config-driven (detect inspects `accepts[0].network`).
 */
export class StellarX402Adapter implements PaymentAdapter {
  readonly protocol = 'stellar-x402';

  constructor(
    private readonly signer: StellarSigner,
    private readonly chainKey: ChainKey,
    private readonly channelsClient?: StellarChannelsClient,
    private readonly rpcUrl?: string,
  ) {}

  detect(response: Response): boolean {
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) return false;
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const network = decoded?.accepts?.[0]?.network as string | undefined;
      return !!network && network.startsWith('stellar:');
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
    const paymentRequired = this.parsePaymentRequired(response);
    const requirements = paymentRequired.accepts?.[0];
    if (!requirements) throw new ChallengeParseError('No accepts[] in Stellar x402 challenge', 'STELLAR_X402_NO_ACCEPTS');

    // Build signed payload via @x402/stellar (canonical Stellar SDK)
    const { ExactStellarScheme } = await this.loadX402Stellar();
    const x402Signer = await this.adaptSignerForX402();
    const scheme = new ExactStellarScheme(x402Signer, this.rpcUrl ? { url: this.rpcUrl } : undefined);

    const paymentPayload = await scheme.createPaymentPayload(paymentRequired);

    // Optional verify (only when apiKey present — Coinbase free path skips verify and lets settle handle it)
    if (this.channelsClient && this.hasApiKey(this.channelsClient)) {
      const verifyRes = await this.channelsClient.verify(paymentPayload, requirements);
      if (!verifyRes.isValid) {
        throw new NPaymentError(
          `Stellar x402 verify rejected: ${verifyRes.invalidReason ?? 'unknown'}`,
          'STELLAR_X402_VERIFY_FAILED',
        );
      }
    }

    // Retry with encoded x402 v2 payment header
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment-signature', Buffer.from(JSON.stringify(paymentPayload)).toString('base64'));
    retryHeaders.set('x-payment-network', requirements.network);
    retryHeaders.set('x-payment-from', this.signer.address);
    if (ctx?.referenceKey) retryHeaders.set('x-payment-reference-key', ctx.referenceKey);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  // ─── Helpers (private) ───────────────────────────────────────────────────

  private parsePaymentRequired(response: Response): { x402Version: number; accepts: any[] } {
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) throw new ChallengeParseError('Missing payment-required header', 'STELLAR_X402_NO_CHALLENGE');
    try {
      return JSON.parse(Buffer.from(header, 'base64').toString());
    } catch (err) {
      throw new ChallengeParseError(
        `Invalid Stellar x402 payment-required header: ${(err as Error).message}`,
        'STELLAR_X402_BAD_CHALLENGE',
      );
    }
  }

  /** Adapt our StellarSigner to the @x402/stellar signer shape (only address + signAuthEntry). */
  private async adaptSignerForX402(): Promise<{ address: string; signAuthEntry: (entry: string, passphrase: string) => Promise<string> }> {
    return {
      address: this.signer.address,
      signAuthEntry: (entry: string, passphrase: string) => this.signer.signAuthEntry(entry, passphrase),
    };
  }

  private async loadX402Stellar(): Promise<{ ExactStellarScheme: any }> {
    try {
      // Subpath import per @x402/stellar guide
      return await import('@x402/stellar/exact/client' as any);
    } catch {
      throw new NPaymentError(
        '@x402/stellar peer dependency not installed',
        'X402_STELLAR_MISSING',
        'Install: npm install @x402/stellar @x402/core @x402/fetch',
      );
    }
  }

  private hasApiKey(client: StellarChannelsClient): boolean {
    return !!(client as unknown as { apiKey?: string }).apiKey;
  }
}

/** v0.10 — kept for chain-config introspection but no longer used in pay(). */
export const STELLAR_NETWORK_PASSPHRASES: Record<string, string> = {
  'stellar:testnet': 'Test SDF Network ; September 2015',
  'stellar:pubnet': 'Public Global Stellar Network ; September 2015',
};

// Side-effect: ensure CHAINS is importable for downstream chain checks.
void CHAINS;

