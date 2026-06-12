/**
 * OWSWallet — CAIP-2-native multichain wallet (v0.27).
 *
 * Back-compat: every v0.25 method signature is preserved exactly. New CAIP-2
 * methods are added as TypeScript overloads on the same names — runtime
 * dispatch via `typeof` keeps the legacy `(tx, chainId: number)` path sync
 * and EVM-only while routing string CAIP-2 args through the multi-family
 * driver.
 *
 * SOLID:
 *   • S — single class, single responsibility (sign / send for the configured wallet name).
 *   • O — adding a chain family means adding a row to caip2.ts; no edits here.
 *   • L — legacy and CAIP-2 paths return values of the same shape (txHash, signature).
 *   • I — implements the `Signer` interface from types.ts on the CAIP-2 path.
 *   • D — depends on the OWSDriver interface, not on `@open-wallet-standard/core` directly.
 */

import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, TypedData, TypedDataDomain } from 'viem';
import { ViemTransactor } from '../transactor.js';
import type { ChainConfig } from '../types.js';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';
import { owsError } from '../errors.js';
import { resolveFamily, resolveSpec, extractEvmChainId } from './caip2.js';
import { createOWSDriver, type OWSDriver } from './cli-driver.js';
import type { OWSConfig, OWSSignResult, SignedTx, ChainFamily } from './types.js';

export interface TransactionRequest {
  to: string;
  value?: string;
  data?: string;
}

export class OWSWallet {
  /** Wallet name as registered in the OWS vault (`~/.ows/wallets/<uuid>/meta.json`). */
  public readonly walletName: string;

  private readonly privateKey?: Hex;
  private readonly autoFaucet?: boolean;
  private readonly transactors = new Map<number, ViemTransactor>();
  private driver: OWSDriver | null = null;
  private readonly driverReady: Promise<void>;

  constructor(config: OWSConfig) {
    this.walletName = config.wallet;
    this.privateKey = config.privateKey as Hex | undefined;
    this.autoFaucet = config.autoFaucet;
    this.driverReady = createOWSDriver(config.cliPath).then((d) => {
      this.driver = d;
    });
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async ensureReady(): Promise<void> {
    await this.driverReady;
  }

  private getTransactor(chainId: number): ViemTransactor {
    if (!this.privateKey) {
      throw owsError('OWS_SDK_NOT_INSTALLED', 'No privateKey configured and OWS Node SDK not resolvable');
    }
    let t = this.transactors.get(chainId);
    if (!t) {
      const chain = Object.values(CHAINS).find((c: ChainConfig) => c.chainId === chainId);
      if (!chain) throw new NPaymentError(`Chain ${chainId} not found`, 'CHAIN_NOT_FOUND');
      t = new ViemTransactor(chain, this.privateKey, this.autoFaucet);
      this.transactors.set(chainId, t);
    }
    return t;
  }

  private async requireDriver(family: ChainFamily): Promise<OWSDriver> {
    await this.ensureReady();
    if (!this.driver) {
      throw owsError(
        'OWS_SDK_NOT_INSTALLED',
        `OWS-native required for family "${family}"; legacy privateKey path supports EVM only`,
      );
    }
    return this.driver;
  }

  // ─── getAddress (overloaded) ─────────────────────────────────────────────

  /** v0.25 sync EVM path — privateKey-derived address. */
  getAddress(chainId: number): string;
  /** v0.27 CAIP-2 path — async, multi-family. */
  getAddress(caip2: string): Promise<string>;
  getAddress(chainOrCaip2: number | string): string | Promise<string> {
    if (typeof chainOrCaip2 === 'number') {
      // Legacy: returns sync via privateKey if no driver yet, or sync-fallback ''.
      if (this.driver) return ''; // sync fallback when driver active — caller should use getAddressAsync
      return this.getTransactor(chainOrCaip2).getAddress();
    }
    return this.getAddressForCaip2(chainOrCaip2);
  }

  /** v0.25 async EVM path — preserved. */
  async getAddressAsync(chainId: number): Promise<string> {
    await this.ensureReady();
    if (this.driver) return this.driver.getAddress(this.walletName, chainId);
    return this.getTransactor(chainId).getAddress();
  }

  private async getAddressForCaip2(caip2: string): Promise<string> {
    const family = resolveFamily(caip2);
    // EVM short-circuit: if we have a privateKey and no driver, derive locally.
    if (family === 'evm' && this.privateKey && !this.driver) {
      const chainId = extractEvmChainId(caip2);
      if (chainId === null) throw owsError('OWS_INVALID_CAIP2', `EVM CAIP-2 must include numeric chainId: ${caip2}`);
      return this.getTransactor(chainId).getAddress();
    }
    const driver = await this.requireDriver(family);
    return driver.getAddressForCaip2(this.walletName, caip2);
  }

  // ─── getBalance (legacy only — CAIP-2 balance is family-specific, deferred) ─

  async getBalance(token: string, chainId: number): Promise<bigint> {
    await this.ensureReady();
    if (this.driver) return this.driver.getBalance(this.walletName, chainId, token);
    return this.getTransactor(chainId).getTokenBalance(this.getTransactor(chainId).getAddress(), token);
  }

  // ─── signTransaction (overloaded) ────────────────────────────────────────

  /** v0.25 EVM signed-and-broadcast path. */
  signTransaction(tx: TransactionRequest, chainId: number): Promise<OWSSignResult>;
  /** v0.27 CAIP-2 signed-and-broadcast path. */
  signTransaction(tx: unknown, caip2: string): Promise<SignedTx>;
  async signTransaction(tx: unknown, chain: number | string): Promise<OWSSignResult | SignedTx> {
    if (typeof chain === 'number') {
      await this.ensureReady();
      const reqTx = tx as TransactionRequest;
      if (this.driver) {
        const txHash = await this.driver.signTransaction(this.walletName, chain, reqTx);
        return { txHash, blockNumber: 0n };
      }
      const result = await this.getTransactor(chain).sendTransaction({
        to: reqTx.to,
        value: reqTx.value ? BigInt(reqTx.value) : undefined,
        data: reqTx.data,
      });
      return { txHash: result.txHash, blockNumber: result.blockNumber };
    }
    return this.signAndSend(chain, tx);
  }

  // ─── transferERC20 (overloaded for back-compat with chain-string) ───────

  /** v0.25 ERC-20 transfer. */
  transferERC20(to: string, token: string, amount: bigint, chainId: number): Promise<OWSSignResult>;
  /** v0.27 CAIP-2 ERC-20 transfer (still EVM-only — non-EVM chains use chain-specific adapters). */
  transferERC20(to: string, token: string, amount: bigint, caip2: string): Promise<SignedTx>;
  async transferERC20(to: string, token: string, amount: bigint, chain: number | string): Promise<OWSSignResult | SignedTx> {
    if (typeof chain === 'number') {
      await this.ensureReady();
      if (this.driver) {
        const txHash = await this.driver.transferERC20(this.walletName, chain, to, token, amount);
        return { txHash, blockNumber: 0n };
      }
      const result = await this.getTransactor(chain).transferERC20(to, token, amount);
      return { txHash: result.txHash, blockNumber: result.blockNumber };
    }
    const family = resolveFamily(chain);
    if (family !== 'evm') {
      throw owsError('OWS_FAMILY_PARTIAL', `transferERC20 is EVM-only; got family ${family} for ${chain}`);
    }
    const chainId = extractEvmChainId(chain);
    if (chainId === null) throw owsError('OWS_INVALID_CAIP2', `EVM CAIP-2 must include numeric chainId: ${chain}`);
    return this.transferERC20(to, token, amount, chainId);
  }

  // ─── signMessage (overloaded) ────────────────────────────────────────────

  /** v0.25 EIP-191 EVM message signing via privateKey or driver. */
  signMessage(message: string): Promise<string>;
  /** v0.27 CAIP-2 message signing across all 11 families. */
  signMessage(caip2: string, message: string): Promise<string>;
  async signMessage(arg1: string, arg2?: string): Promise<string> {
    if (arg2 === undefined) {
      // Legacy single-arg path — EVM EIP-191
      await this.ensureReady();
      if (this.driver) return this.driver.signMessage(this.walletName, arg1);
      if (!this.privateKey) throw owsError('OWS_SDK_NOT_INSTALLED');
      const account = privateKeyToAccount(this.privateKey);
      return account.signMessage({ message: arg1 });
    }
    // CAIP-2 path
    const family = resolveFamily(arg1);
    if (family === 'evm' && this.privateKey && !this.driver) {
      const account = privateKeyToAccount(this.privateKey);
      return account.signMessage({ message: arg2 });
    }
    const driver = await this.requireDriver(family);
    return driver.signMessageForCaip2(this.walletName, arg1, arg2);
  }

  // ─── signAndSend (new, CAIP-2-only) ──────────────────────────────────────

  async signAndSend(caip2: string, txPayload: unknown): Promise<SignedTx> {
    const family = resolveFamily(caip2);
    // EVM legacy short-circuit: if we have a privateKey and no driver, fall through to viem.
    if (family === 'evm' && this.privateKey && !this.driver) {
      const chainId = extractEvmChainId(caip2);
      if (chainId === null) throw owsError('OWS_INVALID_CAIP2', `EVM CAIP-2 must include numeric chainId: ${caip2}`);
      const reqTx = txPayload as TransactionRequest;
      const result = await this.getTransactor(chainId).sendTransaction({
        to: reqTx.to,
        value: reqTx.value ? BigInt(reqTx.value) : undefined,
        data: reqTx.data,
      });
      return { txHash: result.txHash, blockNumber: result.blockNumber, family };
    }
    const driver = await this.requireDriver(family);
    return driver.signAndSendForCaip2(this.walletName, caip2, txPayload);
  }

  // ─── transfer (new, CAIP-2-keyed convenience over signAndSend) ──────────

  async transfer(caip2: string, to: string, asset: string, amount: bigint): Promise<SignedTx> {
    const family = resolveFamily(caip2);
    if (family === 'evm') {
      const chainId = extractEvmChainId(caip2);
      if (chainId === null) throw owsError('OWS_INVALID_CAIP2', `EVM CAIP-2 must include numeric chainId: ${caip2}`);
      const result = await this.transferERC20(to, asset, amount, chainId);
      return { txHash: result.txHash, blockNumber: result.blockNumber, family };
    }
    // Non-EVM: caller passes an already-encoded family-native payload via
    // signAndSend. transfer() at this layer is a convenience for EVM only —
    // chain-specific adapters (xrpl, solana, cosmos) handle native transfers.
    throw owsError(
      'OWS_FAMILY_PARTIAL',
      `transfer() is EVM-only convenience; for ${family} use the chain-specific adapter or signAndSend directly`,
    );
  }

  // ─── signTypedData (EVM only — preserved) ────────────────────────────────

  /**
   * Sign EIP-712 typed data. EVM-only. Used for EIP-3009 sponsored payments.
   * OWS driver path requires native EIP-712 in the SDK (still partial in v1.3.2);
   * for now, callers using sponsored mode must supply ows.privateKey.
   */
  async signTypedData<T extends TypedData>(params: {
    domain: TypedDataDomain;
    types: T;
    primaryType: keyof T extends string ? keyof T : never;
    message: Record<string, unknown>;
  }): Promise<Hex> {
    await this.ensureReady();
    if (!this.privateKey) {
      throw new NPaymentError(
        'signTypedData requires ows.privateKey (OWS driver EIP-712 path not yet wired)',
        'NO_TYPED_DATA_SIGNER',
        'Pass ows: { privateKey: "0x..." } when using EIP-3009 sponsored payments.',
      );
    }
    const account = privateKeyToAccount(this.privateKey);
    return account.signTypedData({
      domain: params.domain,
      types: params.types,
      primaryType: params.primaryType as string,
      message: params.message,
    } as Parameters<typeof account.signTypedData>[0]);
  }

  // ─── Misc preserved methods ──────────────────────────────────────────────

  async payX402(_url: string, _method?: string): Promise<string> {
    throw new NPaymentError('payX402 requires direct adapter usage', 'NOT_IMPLEMENTED');
  }

  /** Returns a viem LocalAccount if privateKey is available, null otherwise. */
  getAccount(): ReturnType<typeof privateKeyToAccount> | null {
    if (!this.privateKey) return null;
    return privateKeyToAccount(this.privateKey);
  }

  /** Resolve the OWS chain family for a CAIP-2 — exposed for adapter layers. */
  resolveFamily(caip2: string): ChainFamily {
    return resolveFamily(caip2);
  }

  /** Inspect the family spec (curve, slip44, derivation path) for a CAIP-2. */
  resolveSpec(caip2: string) {
    return resolveSpec(caip2);
  }
}

// ─── Aliased export — v0.27 introduces the camelCase `OwsWallet` alongside ───
//                     the legacy `OWSWallet`. Both names point to the same class.
export { OWSWallet as OwsWallet };
