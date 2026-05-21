/**
 * AaveClient — Lightweight wrapper over Aave protocol data.
 * Uses public RPC/subgraph endpoints; no @aave/client peer dep required at runtime.
 */
import type { Address } from 'viem';

export const GHO_ADDRESSES: Record<string, Address> = {
  'ethereum': '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
  'base-mainnet': '0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee',
  'arbitrum': '0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33',
  'avalanche': '0xfc421aD3C883Bf9E7C4f42dE845C4e4405799e73',
};

export const AAVE_POOL_ADDRESSES: Record<string, Address> = {
  'base-mainnet': '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  'ethereum': '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  'arbitrum': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
};

export const GHO_FLASH_MINTER: Record<string, Address> = {
  'ethereum': '0xb639D208Bcf0589D54FaC24E655C79EC529762B8',
};

export interface AaveMarketData {
  asset: string;
  supplyAPY: number;
  borrowAPY: number;
  totalLiquidity: bigint;
  utilizationRate: number;
}

export interface AaveUserPosition {
  totalCollateralUSD: bigint;
  totalDebtUSD: bigint;
  availableBorrowsUSD: bigint;
  healthFactor: bigint;
}

/**
 * Read-only Aave client. Queries on-chain data via viem publicClient.
 */
export class AaveClient {
  constructor(private chainKey: string) {}

  getGhoAddress(): Address | undefined {
    return GHO_ADDRESSES[this.chainKey];
  }

  getPoolAddress(): Address | undefined {
    return AAVE_POOL_ADDRESSES[this.chainKey];
  }

  getFlashMinterAddress(): Address | undefined {
    return GHO_FLASH_MINTER[this.chainKey];
  }

  /** Check if Aave is available on this chain */
  isSupported(): boolean {
    return !!AAVE_POOL_ADDRESSES[this.chainKey];
  }
}
