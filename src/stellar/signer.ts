import { NPaymentError } from '../errors.js';

/**
 * Wallet-agnostic signer used by all Stellar adapters.
 * Implementations: KeypairStellarSigner (server), FreighterStellarSigner (browser).
 * Users can plug in Albedo / Hana / OneKey by implementing these three methods.
 */
export interface StellarSigner {
  /** Stellar public key (G... address). */
  readonly address: string;
  /** Sign a Soroban auth entry for x402 / MPP Charge auth-entry signing. */
  signAuthEntry(entryBase64: string, networkPassphrase: string): Promise<string>;
  /** Sign a full Stellar transaction XDR (used in Push mode and channel close). */
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
  /** Raw ed25519 sign over arbitrary bytes — required for MPP Session commitment signing. */
  signRaw(bytes: Uint8Array): Promise<Uint8Array>;
}

// ─── KeypairStellarSigner — server-side, dynamic-import @stellar/stellar-sdk ─

export class KeypairStellarSigner implements StellarSigner {
  readonly address: string;
  private readonly secret: string;
  private sdk: any;

  constructor(secret: string, addressOverride?: string) {
    if (!secret) throw new NPaymentError('Stellar secret key required', 'STELLAR_NO_SECRET');
    this.secret = secret;
    this.address = addressOverride ?? '';
  }

  /** Async factory — derives address via SDK without blocking constructor. */
  static async fromSecret(secret: string): Promise<KeypairStellarSigner> {
    const signer = new KeypairStellarSigner(secret);
    const sdk = await signer.loadSdk();
    (signer as { address: string }).address = sdk.Keypair.fromSecret(secret).publicKey();
    return signer;
  }

  async signAuthEntry(entryBase64: string, _networkPassphrase: string): Promise<string> {
    const sdk = await this.loadSdk();
    const keypair = sdk.Keypair.fromSecret(this.secret);
    const sig = keypair.sign(Buffer.from(entryBase64, 'base64'));
    return Buffer.from(sig).toString('base64');
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const sdk = await this.loadSdk();
    const keypair = sdk.Keypair.fromSecret(this.secret);
    const tx = sdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
    tx.sign(keypair);
    return tx.toXDR();
  }

  async signRaw(bytes: Uint8Array): Promise<Uint8Array> {
    const sdk = await this.loadSdk();
    const keypair = sdk.Keypair.fromSecret(this.secret);
    return new Uint8Array(keypair.sign(Buffer.from(bytes)));
  }

  private async loadSdk() {
    if (this.sdk) return this.sdk;
    try {
      this.sdk = await import('@stellar/stellar-sdk');
      return this.sdk;
    } catch {
      throw new NPaymentError(
        '@stellar/stellar-sdk peer dependency not installed',
        'STELLAR_SDK_MISSING',
        'Install: npm install @stellar/stellar-sdk',
      );
    }
  }
}

// ─── FreighterStellarSigner — browser reference impl ────────────────────────

export class FreighterStellarSigner implements StellarSigner {
  address: string = '';
  private freighter: any;

  /** Lazy-init: prompts wallet for address on first call. */
  static async connect(): Promise<FreighterStellarSigner> {
    const signer = new FreighterStellarSigner();
    const api = await signer.loadFreighter();
    const { address } = await api.requestAccess();
    signer.address = address;
    return signer;
  }

  async signAuthEntry(entryBase64: string, networkPassphrase: string): Promise<string> {
    const api = await this.loadFreighter();
    const { signedAuthEntry } = await api.signAuthEntry(entryBase64, { networkPassphrase, address: this.address });
    return signedAuthEntry;
  }

  async signTransaction(xdr: string, networkPassphrase: string): Promise<string> {
    const api = await this.loadFreighter();
    const { signedTxXdr } = await api.signTransaction(xdr, { networkPassphrase, address: this.address });
    return signedTxXdr;
  }

  async signRaw(_bytes: Uint8Array): Promise<Uint8Array> {
    throw new NPaymentError(
      'Freighter does not expose raw ed25519 signing — use a dedicated commitment key for MPP Session',
      'FREIGHTER_NO_RAW_SIGN',
      'Generate a separate commitment ed25519 key for the channel and pass it via StellarSessionClient',
    );
  }

  private async loadFreighter() {
    if (this.freighter) return this.freighter;
    try {
      this.freighter = await import('@stellar/freighter-api' as any);
      return this.freighter;
    } catch {
      throw new NPaymentError(
        '@stellar/freighter-api peer dependency not installed or not in browser context',
        'FREIGHTER_NOT_AVAILABLE',
        'Install: npm install @stellar/freighter-api (browser only)',
      );
    }
  }
}
