export interface OWSConfig {
  wallet: string;
  privateKey: string;
  autoFaucet?: boolean;
}

export interface OWSSignResult {
  txHash: string;
  blockNumber: bigint;
}
