import { XrplWallet } from './wallet.js';
import { XrplConnection } from './connection.js';
import { XrplVaultClient } from './vault.js';
import { DiaOracleClient } from './oracle.js';
import { XrplSwapClient } from './swap.js';
import { ensureTrustLine, sendRLUSD, getRLUSDBalance, readAccountState } from './payments.js';
import { getRlusdIssuer, networkFromChainKey, RLUSD_CURRENCY, type XrplNetwork } from './utils.js';
import type { ChainKey } from '../types.js';

export interface XrplClientConfig {
  seed?: string;
  owsWallet?: string;
  server?: string;
  network?: XrplNetwork;
  /** Inject a shared XrplConnection (avoids duplicate websockets). */
  connection?: XrplConnection;
}

export interface XrplHealthReport {
  connected: boolean;
  network: XrplNetwork;
  walletAddress?: string;
  trustlineReady: boolean;
  rippledLatencyMs?: number;
  ammLiquidityXrpRlusd?: { xrpDrops: string; rlusd: string } | null;
  warnings: string[];
}

export class XrplClient {
  readonly wallet: XrplWallet;
  readonly connection: XrplConnection;
  readonly vault: XrplVaultClient;
  readonly oracle: DiaOracleClient;
  readonly swap: XrplSwapClient;
  readonly network: XrplNetwork;
  readonly issuer: string;

  constructor(config: XrplClientConfig) {
    this.network = config.network ?? 'testnet';
    this.issuer = getRlusdIssuer(this.network);
    const chainKey: ChainKey = this.network === 'mainnet' ? 'xrpl-mainnet' : 'xrpl-testnet';

    this.wallet = new XrplWallet({ seed: config.seed, owsWallet: config.owsWallet });
    this.connection = config.connection ?? new XrplConnection(config.server ?? chainKey);
    this.vault = new XrplVaultClient(this.connection, this.wallet, this.issuer);
    this.oracle = new DiaOracleClient(this.connection, this.network);
    this.swap = new XrplSwapClient(this.connection, this.wallet, this.network, this.issuer);
  }

  getAddress(): Promise<string> { return this.wallet.getAddress(); }

  ensureTrustLine(): Promise<string | null> {
    return ensureTrustLine(this.connection, this.wallet, { issuer: this.issuer });
  }

  sendRLUSD(destination: string, amount: string): Promise<{ hash: string; validated: boolean }> {
    return sendRLUSD(this.connection, this.wallet, destination, amount, { issuer: this.issuer });
  }

  async getBalance(address?: string): Promise<string> {
    const addr = address ?? (await this.wallet.getAddress());
    return getRLUSDBalance(this.connection, addr, { issuer: this.issuer });
  }

  /**
   * Preflight diagnostic — connection state, trust line, AMM liquidity for XRP/RLUSD.
   * Run once at boot before serving paywall traffic. Never throws — collects into `warnings`.
   */
  async health(): Promise<XrplHealthReport> {
    const warnings: string[] = [];
    let connected = false;
    let trustlineReady = false;
    let walletAddress: string | undefined;
    let rippledLatencyMs: number | undefined;
    let ammLiquidityXrpRlusd: XrplHealthReport['ammLiquidityXrpRlusd'] = null;

    try {
      const t0 = Date.now();
      const client = await this.connection.getClient();
      rippledLatencyMs = Date.now() - t0;
      connected = !!client.isConnected?.();
      try {
        walletAddress = await this.wallet.getAddress();
        const state = await readAccountState(this.connection, walletAddress, { issuer: this.issuer });
        trustlineReady = state.trustlineExists;
        if (!trustlineReady) warnings.push('No RLUSD trust line — call ensureTrustLine() before paying.');
      } catch (e) {
        warnings.push(`Wallet read failed: ${(e as Error).message}`);
      }
      try {
        const ammResp = await client.request({
          command: 'amm_info',
          asset: { currency: 'XRP' },
          asset2: { currency: RLUSD_CURRENCY, issuer: this.issuer },
        });
        const pool = ammResp.result?.amm;
        if (pool?.amount && pool?.amount2) {
          const xrpSide = typeof pool.amount === 'string' ? pool.amount : pool.amount?.value ?? '0';
          const rlusdSide = typeof pool.amount2 === 'string' ? pool.amount2 : pool.amount2?.value ?? '0';
          ammLiquidityXrpRlusd = { xrpDrops: xrpSide, rlusd: rlusdSide };
        } else {
          warnings.push('No XRP/RLUSD AMM pool on this network — autoSwap will fail.');
        }
      } catch (e) {
        warnings.push(`amm_info failed: ${(e as Error).message}`);
      }
    } catch (e) {
      warnings.push(`Connection error: ${(e as Error).message}`);
    }

    return {
      connected,
      network: this.network,
      walletAddress,
      trustlineReady,
      rippledLatencyMs,
      ammLiquidityXrpRlusd,
      warnings,
    };
  }

  /** Resolve to the chain key matching the network — convenience for callers. */
  get chainKey(): ChainKey { return this.network === 'mainnet' ? 'xrpl-mainnet' : 'xrpl-testnet'; }

  /** Static helper for callers who only have a ChainKey. */
  static networkOf(chainKey: ChainKey): XrplNetwork { return networkFromChainKey(chainKey); }

  async disconnect(): Promise<void> { await this.connection.disconnect(); }
}

export function createXrplClient(config: XrplClientConfig): XrplClient {
  return new XrplClient(config);
}
