import type { ChainKey } from '../types.js';
import type { StellarSigner } from './signer.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';
import type { StellarAssetSymbol } from './assets.js';

/**
 * MPP Session — thin reimplementation of the off-chain payment-channel flow.
 *
 * The client signs cumulative ed25519 commitments off-chain. The server tracks the highest
 * commitment seen and settles by calling close() on the one-way-channel Soroban contract
 * with the largest committed amount + signature.
 *
 * No per-payment on-chain transaction. Ideal for high-frequency AI agent micropayments.
 *
 * v0.21 — optional asset binding. When `asset` is provided on both client and server,
 * the commitment preimage incorporates a 12-byte asset code, making vouchers replay-safe
 * across asset boundaries. When `asset` is undefined on both sides, falls back to the
 * v0.20 preimage byte-shape (back-compat — no Soroban contract redeployment required).
 *
 * Reference: https://developers.stellar.org/docs/build/agentic-payments/mpp/channel-guide
 */

/**
 * DRY helper — single source of the preimage byte layout used by both client and server.
 * v0.20 layout (asset undefined): channel ++ amount(16 BE).
 * v0.21 layout (asset defined):   channel ++ asset(12, zero-padded) ++ amount(16 BE).
 */
function computeCommitmentPreimageBytes(
  channel: string,
  cumulativeAmount: bigint,
  asset?: StellarAssetSymbol,
): Uint8Array {
  const channelBytes = Buffer.from(channel, 'utf8');
  const amountBytes = Buffer.alloc(16);
  let amount = cumulativeAmount;
  for (let i = 15; i >= 0; i--) {
    amountBytes[i] = Number(amount & 0xffn);
    amount >>= 8n;
  }
  if (!asset) {
    // v0.20 back-compat path.
    return new Uint8Array(Buffer.concat([channelBytes, amountBytes]));
  }
  const assetBytes = Buffer.alloc(12);
  Buffer.from(asset, 'utf8').copy(assetBytes);
  return new Uint8Array(Buffer.concat([channelBytes, assetBytes, amountBytes]));
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface StellarSessionClientConfig {
  /** Deployed one-way-channel Soroban contract id (C... 56 chars). */
  channel: string;
  /** Hex-encoded ed25519 secret used to sign commitments — separate from the user's payment key. */
  commitmentSecretHex: string;
  /** Chain (testnet/mainnet) — selects passphrase + RPC. */
  chainKey: ChainKey;
  /** Override Soroban RPC. Default: chain.rpcUrl. */
  rpcUrl?: string;
  /**
   * v0.21 — declare which Stellar brand stable this channel holds (USDC, EURC, MGUSD).
   * When set, the commitment preimage incorporates the asset code, making vouchers
   * replay-safe across asset boundaries. Defaults to undefined for v0.20 back-compat.
   * Server must use the same `asset` value or all signatures will fail to verify.
   */
  asset?: StellarAssetSymbol;
}

export interface VoucherCredential {
  /** Base64-encoded JSON: { channel, cumulativeAmount, signature }. */
  credential: string;
  /** Latest cumulative amount in base units. */
  cumulativeAmount: bigint;
}

export class StellarSessionClient {
  private cumulative = 0n;
  private commitmentSecret: Uint8Array;
  private sdk: any;

  constructor(private readonly config: StellarSessionClientConfig) {
    if (config.commitmentSecretHex.length !== 64) {
      throw new NPaymentError(
        'commitmentSecretHex must be 64-char hex (32-byte ed25519 seed)',
        'STELLAR_SESSION_BAD_KEY',
      );
    }
    this.commitmentSecret = new Uint8Array(Buffer.from(config.commitmentSecretHex, 'hex'));
  }

  /**
   * Sign a new voucher for `amount` more units. Returns the cumulative voucher credential
   * to attach as `Authorization: Payment <credential>` on the next request.
   */
  async signCommitment(amount: bigint): Promise<VoucherCredential> {
    if (amount <= 0n) throw new NPaymentError('amount must be > 0', 'STELLAR_SESSION_INVALID_AMOUNT');
    this.cumulative += amount;
    const sdk = await this.loadSdk();

    // Simulate prepare_commitment on the channel contract to get the canonical commitment bytes.
    // For simplicity in v0.10 we hash a deterministic preimage here; production uses Soroban
    // simulation to fetch the contract-canonical bytes. Server must use the same preimage.
    const commitmentBytes = this.computeCommitmentPreimage(this.cumulative);
    const keypair = sdk.Keypair.fromRawEd25519Seed(Buffer.from(this.commitmentSecret));
    const signature: Uint8Array = new Uint8Array(keypair.sign(Buffer.from(commitmentBytes)));

    const credential = Buffer.from(JSON.stringify({
      channel: this.config.channel,
      cumulativeAmount: this.cumulative.toString(),
      signature: Buffer.from(signature).toString('base64'),
    })).toString('base64');

    return { credential, cumulativeAmount: this.cumulative };
  }

  getCumulative(): bigint {
    return this.cumulative;
  }

  /** Reset client-side cumulative tracker (e.g. after server-confirmed close). */
  resetCumulative(): void {
    this.cumulative = 0n;
  }

  private computeCommitmentPreimage(cumulativeAmount: bigint): Uint8Array {
    return computeCommitmentPreimageBytes(this.config.channel, cumulativeAmount, this.config.asset);
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

// ─── Server ──────────────────────────────────────────────────────────────────

export interface StellarSessionServerConfig {
  /** Deployed one-way-channel Soroban contract id. */
  channel: string;
  /** Hex-encoded ed25519 public key the channel was initialized with. */
  commitmentPubkeyHex: string;
  /** Chain (testnet/mainnet). */
  chainKey: ChainKey;
  /** Stellar signer used to sign the close() transaction (server's account, pays close fee). */
  closeSigner: StellarSigner;
  /** Override Soroban RPC. */
  rpcUrl?: string;
  /**
   * v0.21 — declare expected Stellar brand stable for this channel. Must match the client's
   * `asset` field; mismatch causes all `verifyVoucher` calls to fail (replay-safe across
   * asset boundaries). Undefined on both sides preserves v0.20 byte shape.
   */
  asset?: StellarAssetSymbol;
}

export class StellarSessionServer {
  private highestCumulative = 0n;
  private highestSignature?: Uint8Array;
  private sdk: any;

  constructor(private readonly config: StellarSessionServerConfig) {
    if (config.commitmentPubkeyHex.length !== 64) {
      throw new NPaymentError(
        'commitmentPubkeyHex must be 64-char hex (32-byte ed25519 public key)',
        'STELLAR_SESSION_BAD_KEY',
      );
    }
  }

  /**
   * Verify a voucher credential from the client. Updates highest-seen cumulative on success.
   * Replay-protected: voucher with cumulative ≤ highestSeen is rejected.
   */
  async verifyVoucher(credential: string, declaredAmount: bigint): Promise<{ valid: true; cumulativeAmount: bigint } | { valid: false; reason: string }> {
    let parsed: { channel: string; cumulativeAmount: string; signature: string };
    try {
      parsed = JSON.parse(Buffer.from(credential, 'base64').toString());
    } catch {
      return { valid: false, reason: 'malformed credential' };
    }

    if (parsed.channel !== this.config.channel) return { valid: false, reason: 'channel mismatch' };
    const cumulativeAmount = BigInt(parsed.cumulativeAmount);

    // Replay protection — must monotonically increase by exactly declaredAmount
    if (cumulativeAmount <= this.highestCumulative) {
      return { valid: false, reason: `cumulativeAmount ${cumulativeAmount} ≤ highestSeen ${this.highestCumulative}` };
    }
    if (cumulativeAmount - this.highestCumulative !== declaredAmount) {
      return { valid: false, reason: `delta ${cumulativeAmount - this.highestCumulative} ≠ declared ${declaredAmount}` };
    }

    const sdk = await this.loadSdk();
    const pubkeyG = sdk.StrKey.encodeEd25519PublicKey(Buffer.from(this.config.commitmentPubkeyHex, 'hex'));
    const pubkey = sdk.Keypair.fromPublicKey(pubkeyG);
    const preimage = this.computeCommitmentPreimage(cumulativeAmount);
    const sigBytes = Buffer.from(parsed.signature, 'base64');

    if (!pubkey.verify(Buffer.from(preimage), sigBytes)) {
      return { valid: false, reason: 'invalid signature' };
    }

    this.highestCumulative = cumulativeAmount;
    this.highestSignature = new Uint8Array(sigBytes);
    return { valid: true, cumulativeAmount };
  }

  /**
   * Close the channel — submits one on-chain transaction transferring the highest cumulative
   * amount from the channel to the recipient configured at deploy time.
   * Returns the transaction hash.
   */
  async closeChannel(): Promise<{ txHash: string; cumulativeAmount: bigint }> {
    if (!this.highestSignature) {
      throw new NPaymentError('no commitment to close — server has not seen any voucher yet', 'STELLAR_SESSION_NO_COMMITMENT');
    }
    const sdk = await this.loadSdk();
    const passphrase = this.passphrase();
    const rpcUrl = this.config.rpcUrl ?? CHAINS[this.config.chainKey].rpcUrl;

    // Build close() invocation against the one-way-channel contract.
    const server = new sdk.SorobanRpc.Server(rpcUrl);
    const account = await server.getAccount(this.config.closeSigner.address);
    const contract = new sdk.Contract(this.config.channel);
    const tx = new sdk.TransactionBuilder(account, { fee: '10000', networkPassphrase: passphrase })
      .addOperation(contract.call(
        'close',
        sdk.nativeToScVal(this.highestCumulative, { type: 'i128' }),
        sdk.xdr.ScVal.scvBytes(Buffer.from(this.highestSignature)),
      ))
      .setTimeout(30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    const signedXdr = await this.config.closeSigner.signTransaction(prepared.toXDR(), passphrase);
    const sendResult = await server.sendTransaction(sdk.TransactionBuilder.fromXDR(signedXdr, passphrase));

    return { txHash: sendResult.hash, cumulativeAmount: this.highestCumulative };
  }

  getHighestCumulative(): bigint {
    return this.highestCumulative;
  }

  private computeCommitmentPreimage(cumulativeAmount: bigint): Uint8Array {
    return computeCommitmentPreimageBytes(this.config.channel, cumulativeAmount, this.config.asset);
  }

  private passphrase(): string {
    return this.config.chainKey === 'stellar-mainnet'
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';
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
