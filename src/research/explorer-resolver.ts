/**
 * v0.31 — Multi-chain block explorer resolution engine for
 * OnchainLendingResearchService. Follows this repo's AaveClient
 * chain-keyed-address-map convention (src/aave/client.ts) rather than
 * inventing a new pattern.
 *
 * Scope note: only the 4 chains confirmed supported by the research
 * service (RESEARCH_SUPPORTED_CHAINS in ./types.ts) get dedicated entries.
 * The original PRD also listed a Flare mainnet explorer URL
 * (https://flare-explorer.flare.network — independently re-verified as
 * real via dev.flare.network during implementation), but Flare is not yet
 * a RESEARCH_SUPPORTED_CHAINS member, so it is intentionally omitted here
 * to avoid resolving links for a chain no adapter actually targets.
 */
import type { ExplorerLinks } from './types.js';

interface ExplorerConfig {
  base: string;
  phalcon?: string;
  tenderlySlug?: string;
}

const EXPLORER_MAP: Record<string, ExplorerConfig> = {
  'ethereum-mainnet': {
    base: 'https://etherscan.io',
    phalcon: 'https://phalcon.blocksec.com/tx/eth',
    tenderlySlug: 'mainnet',
  },
  'base-mainnet': {
    base: 'https://basescan.org',
    phalcon: 'https://phalcon.blocksec.com/tx/base',
    tenderlySlug: 'base',
  },
  'arbitrum-one': {
    base: 'https://arbiscan.io',
    phalcon: 'https://phalcon.blocksec.com/tx/arbitrum',
    tenderlySlug: 'arbitrum',
  },
  'optimism-mainnet': {
    base: 'https://optimistic.etherscan.io',
    phalcon: 'https://phalcon.blocksec.com/tx/optimism',
    tenderlySlug: 'optimism',
  },
};

const DEFAULT_EXPLORER: ExplorerConfig = { base: 'https://etherscan.io' };

export class ExplorerResolver {
  public static resolve(chain: string, txHash: `0x${string}`): ExplorerLinks {
    const config = EXPLORER_MAP[chain] ?? DEFAULT_EXPLORER;
    return {
      standardExplorer: `${config.base}/tx/${txHash}`,
      callTraceExplorer: config.phalcon
        ? `${config.phalcon}/${txHash}`
        : `${config.base}/tx/${txHash}#internal`,
      simulationSandbox: config.tenderlySlug
        ? `https://dashboard.tenderly.co/tx/${config.tenderlySlug}/${txHash}`
        : `https://dashboard.tenderly.co/tx/mainnet/${txHash}`,
    };
  }

  /** Chains with a dedicated (non-fallback) explorer config. */
  public static supportedChains(): string[] {
    return Object.keys(EXPLORER_MAP);
  }
}
