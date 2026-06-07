import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';
import { assertVerifiedDenom, getInitiaAsset } from './assets.js';
import type { InitiaChainKey } from './types.js';

/**
 * v0.23 — Cosmos-SDK signer + bank-module helpers for Initia (`interwoven-1`,
 * `initiation-2`).
 *
 * SOLID:
 *   SRP — signing + querying on Initia. Bridges, asset registry, and 402 adapter
 *         each live in their own module.
 *   DIP — depends on the abstract {@link InitiaSigner} (matches `OfflineDirectSigner`
 *         from `@cosmjs/proto-signing`); never references the cosmjs concrete types
 *         in its public API.
 *   OCP — extend by composition: pass a custom signer (hardware wallet, OWS, KMS).
 *
 * Soft-loads `@cosmjs/stargate` + `@cosmjs/proto-signing` peer deps; throws
 * `INITIA_PEER_DEP_MISSING` only on first method call (never at import time).
 */

/** Cosmos `OfflineDirectSigner`-shaped abstraction (structural type, not a class). */
export interface InitiaSigner {
  getAccounts(): Promise<ReadonlyArray<{ address: string; pubkey: Uint8Array; algo: string }>>;
  /**
   * Signs a `SignDoc`. We accept `unknown` to avoid leaking cosmjs internal types
   * — the runtime delegates the call to `SigningStargateClient` which validates.
   */
  signDirect(signerAddress: string, signDoc: unknown): Promise<unknown>;
}

export interface InitiaClientConfig {
  chainKey: InitiaChainKey;
  /**
   * Cosmos `OfflineDirectSigner`. May be eager (already-resolved signer) or a
   * lazy thunk — useful when constructing from a mnemonic (which requires
   * `await`) inside a sync code path like `new PaymentClient()`.
   */
  signer?: InitiaSigner | (() => Promise<InitiaSigner>) | Promise<InitiaSigner>;
  /** Override RPC URL. Default: from CHAINS registry. */
  rpcUrl?: string;
  /** Default gas price (uinit per gas). @default '0.015uinit' */
  gasPrice?: string;
  /** Throw on missing peer-dep / signer. @default false */
  strict?: boolean;
}

export interface BroadcastResult {
  txHash: string;
  height: number;
  /** 0 = success; non-zero = failure (rawLog carries the reason). */
  code: number;
  rawLog: string;
  gasUsed: number;
  gasWanted: number;
}

/**
 * Build a Cosmos `OfflineDirectSigner` from a BIP-39 mnemonic. Convenience-only —
 * production agents should construct an `OfflineDirectSigner` externally
 * (hardware wallet, OWS, KMS, ...) and pass it via {@link InitiaClientConfig.signer}.
 */
export async function mnemonicSigner(
  mnemonic: string,
  bech32Prefix = 'init',
): Promise<InitiaSigner> {
  let mod: { DirectSecp256k1HdWallet?: { fromMnemonic: Function } } | undefined;
  try {
    mod = (await import('@cosmjs/proto-signing' as string)) as {
      DirectSecp256k1HdWallet: { fromMnemonic: Function };
    };
  } catch {
    throw new NPaymentError(
      'Cosmos peer-dep missing: @cosmjs/proto-signing',
      'INITIA_PEER_DEP_MISSING',
      'pnpm add @cosmjs/proto-signing @cosmjs/stargate to enable Initia integration.',
    );
  }
  const wallet = await mod!.DirectSecp256k1HdWallet!.fromMnemonic(mnemonic, { prefix: bech32Prefix });
  return wallet as unknown as InitiaSigner;
}

interface StargateModule {
  StargateClient: { connect: (rpc: string) => Promise<StargateQuery> };
  SigningStargateClient: {
    connectWithSigner: (rpc: string, signer: unknown, opts: unknown) => Promise<SigningClient>;
  };
  GasPrice: { fromString: (s: string) => unknown };
}
interface StargateQuery {
  getBalance(addr: string, denom: string): Promise<{ amount: string; denom: string }>;
  disconnect(): void;
}
interface SigningClient {
  sendTokens(
    sender: string,
    recipient: string,
    amount: ReadonlyArray<{ denom: string; amount: string }>,
    fee: 'auto' | unknown,
    memo: string,
  ): Promise<{
    transactionHash: string;
    height: number;
    code?: number;
    rawLog?: string;
    gasUsed?: number | bigint;
    gasWanted?: number | bigint;
  }>;
  disconnect?(): void;
}

export class InitiaClient {
  private cached?: { signing: SigningClient; address: string };
  private stargateMod?: StargateModule;

  constructor(public readonly config: InitiaClientConfig) {}

  /** Resolved bech32 address of the configured signer. */
  async getAddress(): Promise<string> {
    return (await this.connect()).address;
  }

  /** Read any denom balance for any Initia address (no signer required). */
  async getBalance(address: string, denom: string): Promise<bigint> {
    const sg = await this.loadStargate();
    const q = await sg.StargateClient.connect(this.rpcUrl());
    try {
      const coin = await q.getBalance(address, denom);
      return BigInt(coin.amount ?? '0');
    } finally {
      q.disconnect();
    }
  }

  /** Convenience: read iUSD balance for the configured signer's address. */
  async getIusdBalance(): Promise<bigint> {
    const asset = getInitiaAsset(this.config.chainKey, 'iUSD');
    assertVerifiedDenom(asset);
    return this.getBalance(await this.getAddress(), asset.denom);
  }

  /**
   * Send a single-denom amount via `bank.MsgSend`. Auto fee (estimate × gasPrice).
   * Returns the broadcast tx hash on success; throws `INITIA_BROADCAST_FAILED`
   * on non-zero result code.
   */
  async send(req: {
    toAddress: string;
    denom: string;
    amount: bigint;
    memo?: string;
  }): Promise<BroadcastResult> {
    const { signing, address } = await this.connect();
    const coins = [{ denom: req.denom, amount: req.amount.toString() }];
    const result = await signing.sendTokens(address, req.toAddress, coins, 'auto', req.memo ?? '');
    const out: BroadcastResult = {
      txHash: result.transactionHash,
      height: result.height,
      code: result.code ?? 0,
      rawLog: result.rawLog ?? '',
      gasUsed: Number(result.gasUsed ?? 0),
      gasWanted: Number(result.gasWanted ?? 0),
    };
    if (out.code !== 0) {
      throw new NPaymentError(
        `Initia broadcast failed (code=${out.code}): ${out.rawLog}`,
        'INITIA_BROADCAST_FAILED',
        'Inspect rawLog; common causes: insufficient funds for fee, account not yet on chain, denom typo.',
      );
    }
    return out;
  }

  /**
   * Send iUSD via the registry-resolved denom. Convenience wrapper over `send`
   * — used by InitiaIusdAdapter.
   */
  async sendIusd(toAddress: string, amount: bigint, memo?: string): Promise<BroadcastResult> {
    const asset = getInitiaAsset(this.config.chainKey, 'iUSD');
    assertVerifiedDenom(asset);
    return this.send({ toAddress, denom: asset.denom, amount, memo });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private rpcUrl(): string {
    return this.config.rpcUrl ?? CHAINS[this.config.chainKey].rpcUrl;
  }

  private async loadStargate(): Promise<StargateModule> {
    if (this.stargateMod) return this.stargateMod;
    try {
      this.stargateMod = (await import('@cosmjs/stargate' as string)) as StargateModule;
      return this.stargateMod;
    } catch {
      const err = new NPaymentError(
        'Cosmos peer-dep missing: @cosmjs/stargate',
        'INITIA_PEER_DEP_MISSING',
        'pnpm add @cosmjs/stargate @cosmjs/proto-signing to enable Initia integration.',
      );
      if (this.config.strict) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[n-payment] ${err.message}: ${err.hint}`);
      throw err;
    }
  }

  private async connect(): Promise<{ signing: SigningClient; address: string }> {
    if (this.cached) return this.cached;
    if (!this.config.signer) {
      throw new NPaymentError(
        'InitiaClient: no signer configured',
        'INITIA_SIGNER_MISSING',
        'Pass a signer to new InitiaClient({ signer }) — e.g. await mnemonicSigner(env.MNEMONIC).',
      );
    }
    const signer = await this.resolveSigner();
    const sg = await this.loadStargate();
    const signing = await sg.SigningStargateClient.connectWithSigner(
      this.rpcUrl(),
      signer,
      { gasPrice: sg.GasPrice.fromString(this.config.gasPrice ?? '0.015uinit') },
    );
    const accounts = await signer.getAccounts();
    const address = accounts[0]?.address;
    if (!address) {
      throw new NPaymentError('InitiaClient: signer returned no accounts', 'INITIA_SIGNER_EMPTY');
    }
    this.cached = { signing, address };
    return this.cached;
  }

  private async resolveSigner(): Promise<InitiaSigner> {
    const s = this.config.signer!;
    if (typeof s === 'function') return s();
    return s as InitiaSigner | Promise<InitiaSigner>;
  }
}
