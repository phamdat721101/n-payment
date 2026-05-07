import type { NPaymentConfig } from './types.js';
import { CHAINS } from './chains.js';
import { NPaymentError } from './errors.js';

export function createConfig(input: NPaymentConfig): NPaymentConfig {
  if (!input.chains?.length) {
    throw new NPaymentError('At least one chain required', 'INVALID_CONFIG', 'Pass chains: ["base-sepolia"]');
  }

  for (const chain of input.chains) {
    if (!CHAINS[chain]) {
      throw new NPaymentError(`Unknown chain: ${chain}`, 'INVALID_CONFIG', `Valid chains: ${Object.keys(CHAINS).join(', ')}`);
    }
  }

  if (!input.ows?.wallet) {
    throw new NPaymentError('ows.wallet is required', 'INVALID_CONFIG', 'Pass ows: { wallet: "my-agent" }');
  }

  // Dual-mode: privateKey is optional if OWS SDK is available
  // Validation of signer availability happens at runtime in OWSWallet

  const hasGoatChain = input.chains.some((c) => CHAINS[c].protocols.includes('goat'));
  if (hasGoatChain && !input.goat) {
    throw new NPaymentError('GOAT chains require goat credentials', 'INVALID_CONFIG', 'Pass goat: { apiKey, apiSecret, merchantId }');
  }

  if (input.btcLending && !hasGoatChain) {
    throw new NPaymentError('btcLending requires a GOAT chain', 'INVALID_CONFIG', 'Add goat-testnet to chains');
  }

  if (input.btcLending && !input.btcLending.vaultAddress) {
    throw new NPaymentError('btcLending.vaultAddress is required', 'INVALID_CONFIG', 'Pass btcLending: { vaultAddress: "0x..." }');
  }

  return { protocol: 'auto', ...input };
}
