export class NPaymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'NPaymentError';
  }
}

export class ChallengeParseError extends NPaymentError {
  override name = 'ChallengeParseError';
}

export class InsufficientBalanceError extends NPaymentError {
  override name = 'InsufficientBalanceError';
}

export class AdapterNotFoundError extends NPaymentError {
  override name = 'AdapterNotFoundError';
}

/**
 * v0.17 — GOAT USDC acquisition router error codes.
 * Every code carries an actionable hint so agents can self-recover or surface
 * a useful message to the operator. Use `goatError(code, contextMsg?)` to construct.
 */
export const GOAT_ACQUISITION_HINTS: Record<string, string> = {
  GOAT_USDC_NOT_RESOLVED: 'Set goat.usdcOverride or upgrade chains.ts with the deployed USDC address.',
  GOAT_NO_VIABLE_PATH: 'Fund the wallet (PegBTC, cross-chain USDC, or BTC L1), or extend goat.autoFund.allowedPaths.',
  GOAT_INSUFFICIENT_PEGBTC: 'Top up PegBTC on GOAT (faucet on testnet, BitVM peg-in on mainnet) or pick a different path.',
  GOAT_SWAP_SLIPPAGE_EXCEEDED: 'Increase goat.autoFund.maxSlippageBps or wait for deeper OKU pool liquidity.',
  GOAT_OFT_FEE_TOO_HIGH: 'Increase goat.autoFund.maxFeeBps or pick a different src chain.',
  GOAT_OFT_PEER_DEP_MISSING: 'Install @layerzerolabs/oft-evm to enable cross-chain USDC, or omit "oft" from allowedPaths.',
  GOAT_BTC_SIGNER_MISSING: 'Pass goat.btcSigner: BtcSigner to enable peg-in, or omit "pegin" from allowedPaths.',
  GOAT_BRIDGE_INTENT_EXPIRED: 'Re-create the peg-in intent — Bitcoin tx was not confirmed in time.',
  GOAT_BRIDGE_INTENT_REPLAYED: 'Each peg-in intent is single-use; create a fresh intent to retry.',
  GOAT_BRIDGE_API_ERROR: 'Check https://bridge.goat.network status; retry with exponential backoff.',
  GOAT_BRIDGE_TIMEOUT: 'Increase the poll timeout, or check the deposit tx confirmation count manually.',
  GOAT_BRIDGE_PSBT_TAMPERED: 'Bridge response did not match intent — potential MITM or compromised endpoint. Aborted before signing.',
  GOAT_AUTOFUND_DISABLED: 'Set goat.autoFund: { enabled: true, allowedPaths: [...] } to enable self-funding.',
  GOAT_AUTOFUND_LIMIT_EXCEEDED: 'Wait for the rolling window to reset, or raise goat.autoFund.maxPerHour / maxPerDay.',
  GOAT_DRY_RUN: 'Set goat.autoFund.dryRun=false to execute; currently in quote-only mode.',
};

/** Construct a GOAT_* NPaymentError with the canonical hint. */
export function goatError(code: keyof typeof GOAT_ACQUISITION_HINTS, contextMessage?: string): NPaymentError {
  const hint = GOAT_ACQUISITION_HINTS[code];
  const message = contextMessage ? `${code}: ${contextMessage}` : code;
  return new NPaymentError(message, code, hint);
}

/**
 * v0.27 — OWS multichain wallet error codes.
 * Each code carries an actionable hint so callers can self-recover or surface
 * a useful message to the operator. Use `owsError(code, contextMsg?)` to construct.
 */
export const OWS_HINTS: Record<string, string> = {
  OWS_CHAIN_FAMILY_NOT_SUPPORTED:
    'Use one of: eip155, solana, bip122, cosmos, tron, ton, sui, xrpl, spark, fil, near. Stellar is not yet in OWS spec — track v0.28 contribution.',
  OWS_SDK_NOT_INSTALLED:
    'Run `pnpm add @open-wallet-standard/core` for OWS-native multichain mode, or pass `ows: { privateKey: "0x..." }` for legacy EVM-only mode.',
  OWS_FAMILY_PARTIAL:
    'Upgrade @open-wallet-standard/core to a version that signs this family, or fall back to the legacy privateKey path for EVM.',
  OWS_WALLET_NOT_FOUND:
    'Run `ows wallet create --name <name>` first, or call `ows.discoverWallets()` to list existing wallets.',
  OWS_CONFIRM_REQUIRED:
    'Pass `confirm: true` explicitly to acknowledge this irreversible action (export / delete / rotate).',
  OWS_POLICY_VIOLATION:
    'Pre-signing policy denied the request. Inspect ~/.ows/policies/<id>.json or use a different API key.',
  OWS_INVALID_CAIP2:
    'CAIP-2 chain ID must be of form `<namespace>:<reference>` (e.g. `eip155:8453`, `xrpl:mainnet`).',
  OWS_CLI_NOT_AVAILABLE:
    'The `ows` CLI binary is required for backup/restore/recover. Install via the OWS docs or pass `ows: { cliPath: "/abs/path/to/ows" }`.',
};

/** Construct an OWS_* NPaymentError with the canonical hint. */
export function owsError(code: keyof typeof OWS_HINTS, contextMessage?: string): NPaymentError {
  const hint = OWS_HINTS[code];
  const message = contextMessage ? `${code}: ${contextMessage}` : code;
  return new NPaymentError(message, code, hint);
}
