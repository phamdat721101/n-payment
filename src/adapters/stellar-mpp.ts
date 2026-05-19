import type { PaymentAdapter, PaymentContext, ChainKey } from '../types.js';
import type { StellarSigner } from '../stellar/signer.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';

/**
 * Stellar MPP Charge adapter — wraps @stellar/mpp/charge/client.
 *
 * Modes:
 *   - 'pull' (default) — server broadcasts the signed transaction; supports sponsored fees
 *   - 'push'           — client broadcasts; sends tx hash for server verification
 *
 * Routing: detects www-authenticate "Payment" + Stellar SAC contract in the asset field.
 */
export type MppChargeMode = 'pull' | 'push';

export class StellarMppAdapter implements PaymentAdapter {
  readonly protocol = 'stellar-mpp';

  constructor(
    private readonly signer: StellarSigner,
    private readonly chainKey: ChainKey,
    private readonly mode: MppChargeMode = 'pull',
  ) {}

  detect(response: Response): boolean {
    const auth = (response.headers.get('www-authenticate') ?? '').toLowerCase();
    return auth.includes('payment') && (auth.includes('stellar') || auth.includes('soroban'));
  }

  async pay(
    url: string,
    init: RequestInit | undefined,
    response: Response,
    ctx?: PaymentContext,
  ): Promise<Response> {
    const challenge = this.parseChallenge(response);
    const networkPassphrase = this.passphrase();

    // Adapt our StellarSigner to the keypair shape @stellar/mpp expects.
    // Only signTransaction is required for pull mode; signAuthEntry for sponsored fees.
    const keypairProxy = this.adaptSignerForMpp(networkPassphrase);

    const { stellar } = await this.loadStellarMpp();
    const credential = await stellar.charge({
      keypair: keypairProxy,
      mode: this.mode,
      // @stellar/mpp reads the rest of the challenge fields from the WWW-Authenticate header
    }).buildCredential(challenge);

    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('authorization', `Payment ${credential}`);
    retryHeaders.set('x-payment-network', challenge.network);
    retryHeaders.set('x-payment-from', this.signer.address);
    if (ctx?.referenceKey) retryHeaders.set('x-payment-reference-key', ctx.referenceKey);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private parseChallenge(response: Response): { recipient: string; amount: string; currency: string; network: string } {
    const auth = response.headers.get('www-authenticate') ?? '';
    const get = (k: string): string | undefined => auth.match(new RegExp(`${k}="([^"]+)"`))?.[1];
    const recipient = get('recipient');
    const amount = get('amount');
    const currency = get('currency');
    const network = get('network') ?? CHAINS[this.chainKey].caip2;
    if (!recipient || !amount || !currency) {
      throw new NPaymentError('Stellar MPP challenge missing recipient/amount/currency', 'STELLAR_MPP_BAD_CHALLENGE');
    }
    return { recipient, amount, currency, network };
  }

  private passphrase(): string {
    return this.chainKey === 'stellar-mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';
  }

  /** Adapt our StellarSigner to the keypair shape @stellar/mpp/charge/client expects. */
  private adaptSignerForMpp(passphrase: string) {
    return {
      publicKey: () => this.signer.address,
      sign: async (data: Buffer | Uint8Array) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        return Buffer.from(await this.signer.signRaw(bytes));
      },
      signTransaction: (xdr: string) => this.signer.signTransaction(xdr, passphrase),
      signAuthEntry: (entry: string) => this.signer.signAuthEntry(entry, passphrase),
    };
  }

  private async loadStellarMpp(): Promise<{ stellar: any }> {
    try {
      return await import('@stellar/mpp/charge/client' as any);
    } catch {
      throw new NPaymentError(
        '@stellar/mpp peer dependency not installed',
        'STELLAR_MPP_MISSING',
        'Install: npm install @stellar/mpp mppx',
      );
    }
  }
}

