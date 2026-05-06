declare module '@open-wallet-standard/core' {
  interface WalletAccount {
    address: string;
    chainId: string;
  }
  interface Wallet {
    accounts: WalletAccount[];
  }
  export function getWallet(name: string): Wallet;
  export function signAndSend(walletName: string, chain: string, tx: { to: string; value?: string; data?: string }): Promise<{ hash: string }>;
  export function signMessage(walletName: string, type: string, message: string): Promise<{ signature: string }>;
}
