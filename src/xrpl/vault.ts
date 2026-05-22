import type { XrplWallet } from './wallet.js';
import type { XrplConnection } from './connection.js';
import { RLUSD_CURRENCY } from './utils.js';

export interface VaultCreateOptions {
  asset?: { currency: string; issuer: string };
  assetsMaximum?: string;
  scale?: number;
  isPrivate?: boolean;
  nonTransferable?: boolean;
}

export interface VaultInfo {
  vaultId: string;
  owner: string;
  asset: { currency: string; issuer: string };
  totalAssets: string;
  totalShares: string;
  lossUnrealized: string;
  sharesMPTId: string;
}

/**
 * XLS-65 single-asset vault client.
 *
 * v0.14: issuer is injected per-network (no hardcoded mainnet issuer).
 */
export class XrplVaultClient {
  constructor(
    private readonly connection: XrplConnection,
    private readonly wallet: XrplWallet,
    /** RLUSD issuer for the wallet's network. Use `getRlusdIssuer(network)`. */
    private readonly issuer: string,
  ) {}

  private defaultAsset(): { currency: string; issuer: string } {
    return { currency: RLUSD_CURRENCY, issuer: this.issuer };
  }

  async createVault(options: VaultCreateOptions = {}): Promise<{ hash: string; vaultId: string }> {
    const client = await this.connection.getClient();
    const address = await this.wallet.getAddress();
    const asset = options.asset ?? this.defaultAsset();

    let flags = 0;
    if (options.isPrivate) flags |= 0x00010000;
    if (options.nonTransferable) flags |= 0x00020000;

    const tx: Record<string, unknown> = {
      TransactionType: 'VaultCreate',
      Account: address,
      Asset: asset,
      Flags: flags,
    };
    if (options.assetsMaximum) tx.AssetsMaximum = options.assetsMaximum;
    if (options.scale !== undefined) tx.Scale = options.scale;

    const prepared = await client.autofill(tx);
    const signed = await this.wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);

    const created = result.result.meta?.AffectedNodes?.find(
      (n: { CreatedNode?: { LedgerEntryType?: string } }) => n.CreatedNode?.LedgerEntryType === 'Vault',
    );
    const vaultId = created?.CreatedNode?.LedgerIndex ?? result.result.hash;
    return { hash: result.result.hash, vaultId };
  }

  async deposit(vaultId: string, amount: string): Promise<{ hash: string; sharesReceived: string }> {
    const client = await this.connection.getClient();
    const address = await this.wallet.getAddress();

    const tx = await client.autofill({
      TransactionType: 'VaultDeposit',
      Account: address,
      VaultID: vaultId,
      Amount: { ...this.defaultAsset(), value: amount },
    });
    const signed = await this.wallet.sign(tx);
    const result = await client.submitAndWait(signed.tx_blob);

    const sharesReceived = this.extractSharesFromMeta(result.result.meta, address) ?? '0';
    return { hash: result.result.hash, sharesReceived };
  }

  async withdraw(
    vaultId: string,
    opts: { amount?: string; shares?: string },
  ): Promise<{ hash: string; assetsReceived: string }> {
    const client = await this.connection.getClient();
    const address = await this.wallet.getAddress();

    const tx: Record<string, unknown> = {
      TransactionType: 'VaultWithdraw',
      Account: address,
      VaultID: vaultId,
    };
    if (opts.amount) tx.Amount = { ...this.defaultAsset(), value: opts.amount };
    else if (opts.shares) tx.Shares = opts.shares;

    const prepared = await client.autofill(tx);
    const signed = await this.wallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);
    return { hash: result.result.hash, assetsReceived: opts.amount ?? '0' };
  }

  async getVaultInfo(vaultId: string): Promise<VaultInfo> {
    const client = await this.connection.getClient();
    const response = await client.request({ command: 'vault_info', vault_id: vaultId });
    const v = response.result.vault ?? response.result;
    return {
      vaultId,
      owner: v.Owner ?? v.Account ?? '',
      asset: v.Asset ?? this.defaultAsset(),
      totalAssets: v.AssetsTotal ?? '0',
      totalShares: v.SharesTotal ?? '0',
      lossUnrealized: v.LossUnrealized ?? '0',
      sharesMPTId: v.MPTokenIssuanceID ?? '',
    };
  }

  async getExchangeRate(vaultId: string): Promise<{ deposit: number; withdrawal: number }> {
    const info = await this.getVaultInfo(vaultId);
    const assets = parseFloat(info.totalAssets);
    const shares = parseFloat(info.totalShares);
    const loss = parseFloat(info.lossUnrealized);
    if (shares === 0) return { deposit: 1, withdrawal: 1 };
    return { deposit: assets / shares, withdrawal: (assets - loss) / shares };
  }

  private extractSharesFromMeta(meta: unknown, address: string): string | null {
    const affected = (meta as { AffectedNodes?: unknown[] } | undefined)?.AffectedNodes;
    if (!Array.isArray(affected)) return null;
    for (const node of affected) {
      const fields =
        (node as { ModifiedNode?: { FinalFields?: Record<string, unknown> }; CreatedNode?: { NewFields?: Record<string, unknown> } })
          .ModifiedNode?.FinalFields ??
        (node as { CreatedNode?: { NewFields?: Record<string, unknown> } }).CreatedNode?.NewFields;
      if (fields?.MPTokenHolder === address && fields?.MPTAmount) return String(fields.MPTAmount);
    }
    return null;
  }
}
