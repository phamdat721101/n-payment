export interface OWSConfig {
  wallet: string;
  privateKey?: string;
  autoFaucet?: boolean;
  cliPath?: string;
  policyId?: string;
}

export interface OWSSignResult {
  txHash: string;
  blockNumber: bigint;
}
