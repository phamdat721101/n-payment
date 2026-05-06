declare module '@open-wallet-standard/core' {
  interface WalletAccount {
    address: string;
    chainId: string;
  }
  interface Wallet {
    accounts: WalletAccount[];
  }
  export function getWallet(name: string): Wallet;
  export function signAndSend(wallet: string, chain: string, txJson: string, passphrase?: string | null, index?: number | null, rpcUrl?: string | null): Promise<{ txHash: string }>;
  export function signMessage(wallet: string, chain: string, message: string, passphrase?: string | null, encoding?: string | null): Promise<{ signature: string }>;
}
