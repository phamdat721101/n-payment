export interface OWSConfig {
  wallet: string;
  apiKey?: string;
  policyId?: string;
  cliPath?: string;
}

export interface OWSExecResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  hint?: string;
}

export interface OWSSignResult {
  txHash: string;
  signedTx: string;
}
