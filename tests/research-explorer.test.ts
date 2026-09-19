import { describe, it, expect } from 'vitest';
import { ExplorerResolver } from '../src/research/explorer-resolver.js';

// PROOF-01 (PRD-03): every standardExplorer URL must match this exact regex.
const STANDARD_EXPLORER_REGEX = /^https:\/\/(etherscan\.io|basescan\.org|arbiscan\.io|optimistic\.etherscan\.io)\/tx\/0x[0-9a-fA-F]{64}$/;

const SAMPLE_TX_HASH = '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50' as `0x${string}`;

describe('ExplorerResolver', () => {
  it('resolves Ethereum mainnet links (Etherscan + Phalcon + Tenderly)', () => {
    const links = ExplorerResolver.resolve('ethereum-mainnet', SAMPLE_TX_HASH);
    expect(links.standardExplorer).toBe(`https://etherscan.io/tx/${SAMPLE_TX_HASH}`);
    expect(links.callTraceExplorer).toBe(`https://phalcon.blocksec.com/tx/eth/${SAMPLE_TX_HASH}`);
    expect(links.simulationSandbox).toBe(`https://dashboard.tenderly.co/tx/mainnet/${SAMPLE_TX_HASH}`);
    expect(links.standardExplorer).toMatch(STANDARD_EXPLORER_REGEX);
  });

  it('resolves Base mainnet links (BaseScan)', () => {
    const links = ExplorerResolver.resolve('base-mainnet', SAMPLE_TX_HASH);
    expect(links.standardExplorer).toBe(`https://basescan.org/tx/${SAMPLE_TX_HASH}`);
    expect(links.callTraceExplorer).toBe(`https://phalcon.blocksec.com/tx/base/${SAMPLE_TX_HASH}`);
    expect(links.standardExplorer).toMatch(STANDARD_EXPLORER_REGEX);
  });

  it('resolves Arbitrum One links (Arbiscan)', () => {
    const links = ExplorerResolver.resolve('arbitrum-one', SAMPLE_TX_HASH);
    expect(links.standardExplorer).toBe(`https://arbiscan.io/tx/${SAMPLE_TX_HASH}`);
    expect(links.callTraceExplorer).toBe(`https://phalcon.blocksec.com/tx/arbitrum/${SAMPLE_TX_HASH}`);
    expect(links.standardExplorer).toMatch(STANDARD_EXPLORER_REGEX);
  });

  it('resolves Optimism mainnet links (Optimistic Etherscan)', () => {
    const links = ExplorerResolver.resolve('optimism-mainnet', SAMPLE_TX_HASH);
    expect(links.standardExplorer).toBe(`https://optimistic.etherscan.io/tx/${SAMPLE_TX_HASH}`);
    expect(links.callTraceExplorer).toBe(`https://phalcon.blocksec.com/tx/optimism/${SAMPLE_TX_HASH}`);
    expect(links.standardExplorer).toMatch(STANDARD_EXPLORER_REGEX);
  });

  it('falls back to Etherscan-shaped links for an unknown/unsupported chain rather than throwing', () => {
    // Cast bypasses the ChainKey type guard deliberately to exercise the runtime fallback path.
    const links = ExplorerResolver.resolve('not-a-real-chain' as never, SAMPLE_TX_HASH);
    expect(links.standardExplorer).toBe(`https://etherscan.io/tx/${SAMPLE_TX_HASH}`);
    expect(links.callTraceExplorer).toContain('#internal');
  });

  it('every supported-chain explorer link is a valid, well-formed URL', () => {
    for (const chain of ['ethereum-mainnet', 'base-mainnet', 'arbitrum-one', 'optimism-mainnet'] as const) {
      const links = ExplorerResolver.resolve(chain, SAMPLE_TX_HASH);
      expect(() => new URL(links.standardExplorer)).not.toThrow();
      expect(() => new URL(links.callTraceExplorer)).not.toThrow();
      expect(() => new URL(links.simulationSandbox)).not.toThrow();
    }
  });
});
