import type { ChainKey, ChainConfig } from './types.js';

export const CHAINS: Record<ChainKey, ChainConfig> = {
  'base-sepolia': {
    chainId: 84532,
    caip2: 'eip155:84532',
    name: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    protocols: ['x402'],
    tokens: { USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
    facilitator: 'https://x402.org/facilitator',
  },
  'arbitrum-sepolia': {
    chainId: 421614,
    caip2: 'eip155:421614',
    name: 'Arbitrum Sepolia',
    rpcUrl: 'https://sepolia-rollup.arbitrum.io/rpc',
    protocols: ['x402'],
    tokens: { USDC: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' },
    facilitator: 'https://x402.org/facilitator',
  },
  'goat-testnet': {
    chainId: 48816,
    caip2: 'eip155:48816',
    name: 'GOAT Testnet3',
    rpcUrl: 'https://rpc.testnet3.goat.network',
    protocols: ['goat'],
    tokens: { USDC: '0x0000000000000000000000000000000000000000', USDT: '0x0000000000000000000000000000000000000000' },
    facilitator: 'https://api.x402.goat.network',
  },
  'goat-mainnet': {
    chainId: 2345,
    caip2: 'eip155:2345',
    name: 'GOAT Network',
    rpcUrl: 'https://rpc.goat.network',
    protocols: ['goat'],
    tokens: { USDC: '0x0000000000000000000000000000000000000000', USDT: '0x0000000000000000000000000000000000000000' },
    facilitator: 'https://api.x402.goat.network',
  },
  'tempo-testnet': {
    chainId: 2,
    caip2: 'tempo:testnet',
    name: 'Tempo Testnet',
    rpcUrl: 'https://rpc.testnet.tempo.xyz',
    protocols: ['mpp'],
    tokens: { PathUSD: '0x20c0000000000000000000000000000000000000' },
  },
};

export function getChain(key: ChainKey): ChainConfig {
  return CHAINS[key];
}

export function getChainsForProtocol(chains: ChainKey[], protocol: string): ChainKey[] {
  return chains.filter((c) => CHAINS[c]?.protocols.includes(protocol));
}
