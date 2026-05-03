import type { OWSWallet } from '../ows/wallet.js';
import type { BtcLendingConfig } from '../types.js';
import { NPaymentError } from '../errors.js';

const VAULT_ABI = {
  lockAndBorrow: '0x1a2b3c4d',
  repayAndUnlock: '0x5e6f7a8b',
} as const;

export class BtcLendingVault {
  private wallet: OWSWallet;
  private vaultAddress: string;
  private collateralRatio: number;

  constructor(wallet: OWSWallet, config: BtcLendingConfig) {
    this.wallet = wallet;
    this.vaultAddress = config.vaultAddress;
    this.collateralRatio = config.collateralRatio ?? 150;
  }

  estimateCollateral(usdcAmountWei: string): string {
    const usdc = BigInt(usdcAmountWei);
    const collateral = (usdc * BigInt(this.collateralRatio)) / 100n;
    return collateral.toString();
  }

  async lockAndBorrow(btcAmountWei: string, usdcAmountWei: string, chainId: number): Promise<string> {
    const paddedBtc = BigInt(btcAmountWei).toString(16).padStart(64, '0');
    const paddedUsdc = BigInt(usdcAmountWei).toString(16).padStart(64, '0');
    const data = `${VAULT_ABI.lockAndBorrow}${paddedBtc}${paddedUsdc}`;
    const { txHash } = await this.wallet.signTransaction({ to: this.vaultAddress, data }, chainId);
    return txHash;
  }

  async repayAndUnlock(positionTxHash: string, chainId: number): Promise<string> {
    const paddedId = positionTxHash.replace('0x', '').padStart(64, '0');
    const data = `${VAULT_ABI.repayAndUnlock}${paddedId}`;
    const { txHash } = await this.wallet.signTransaction({ to: this.vaultAddress, data }, chainId);
    return txHash;
  }
}
