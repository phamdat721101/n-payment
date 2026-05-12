import type { XrplConnection } from './connection.js';

const ORACLE_CONFIG = {
  testnet: { account: 'r3U1mL5u2SCPr4mApqYyF96nvwvKoGf7aH', documentId: 1 },
  mainnet: { account: 'rP24Lp7bcUHvEW7T7c8xkxtQKKd9fZyra7', documentId: 42 },
} as const;

const ASSET_TICKERS: Record<string, string> = {
  RLUSD: '524C555344000000000000000000000000000000',
  XRP: '5852500000000000000000000000000000000000',
  BTC: '4254430000000000000000000000000000000000',
  ETH: '4554480000000000000000000000000000000000',
};

export interface OraclePrice {
  asset: string;
  price: number;
  timestamp: number;
}

export class DiaOracleClient {
  private connection: XrplConnection;
  private network: 'testnet' | 'mainnet';

  constructor(connection: XrplConnection, network: 'testnet' | 'mainnet' = 'testnet') {
    this.connection = connection;
    this.network = network;
  }

  async getPrice(asset: string): Promise<OraclePrice> {
    const client = await this.connection.getClient();
    const config = ORACLE_CONFIG[this.network];

    const response = await client.request({
      command: 'ledger_entry',
      oracle: { account: config.account, oracle_document_id: config.documentId },
      ledger_index: 'validated',
    });

    const priceData = response.result.node?.PriceDataSeries ?? [];
    const tickerHex = ASSET_TICKERS[asset.toUpperCase()] ?? asset;

    const entry = priceData.find(
      (p: any) => p.PriceData?.BaseAsset === tickerHex || p.PriceData?.BaseAsset === asset,
    );

    if (!entry) return { asset, price: 0, timestamp: Date.now() };

    const rawPrice = parseInt(entry.PriceData.AssetPrice, 16);
    const scale = entry.PriceData.Scale ?? 8;
    const price = rawPrice / Math.pow(10, scale);

    return { asset, price, timestamp: Date.now() };
  }

  async getRLUSDPrice(): Promise<number> {
    const result = await this.getPrice('RLUSD');
    return result.price || 1.0; // RLUSD should be ~$1.00
  }

  async getVaultYield(
    currentShareValue: number,
    depositShareValue: number,
  ): Promise<{ yieldPercent: number; absoluteReturn: number }> {
    if (depositShareValue === 0) return { yieldPercent: 0, absoluteReturn: 0 };
    const absoluteReturn = currentShareValue - depositShareValue;
    const yieldPercent = (absoluteReturn / depositShareValue) * 100;
    return { yieldPercent, absoluteReturn };
  }

  async trackVaultYield(
    vaultTotalAssets: string,
    vaultTotalShares: string,
    userShares: string,
    depositAmount: string,
  ): Promise<{ currentValue: number; depositValue: number; yieldPercent: number }> {
    const totalAssets = parseFloat(vaultTotalAssets);
    const totalShares = parseFloat(vaultTotalShares);
    const shares = parseFloat(userShares);
    const deposit = parseFloat(depositAmount);

    const currentValue = totalShares > 0 ? (shares / totalShares) * totalAssets : 0;
    const yieldPercent = deposit > 0 ? ((currentValue - deposit) / deposit) * 100 : 0;

    return { currentValue, depositValue: deposit, yieldPercent };
  }
}
