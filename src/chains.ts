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
    tokens: { USDC: '0x0000000000000000000000000000000000000000', USDT: '0x0000000000000000000000000000000000000000', WBTC: '0x0000000000000000000000000000000000000000', PegBTC: '0x0000000000000000000000000000000000000000' },
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
    chainId: 42431,
    caip2: 'eip155:42431',
    name: 'Tempo Testnet',
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    protocols: ['mpp'],
    tokens: {
      PathUSD: '0x20c0000000000000000000000000000000000000',
      USDC: '0x20C000000000000000000000b9537d11c60E8b50',
    },
  },
  'tempo-mainnet': {
    chainId: 4217,
    caip2: 'eip155:4217',
    name: 'Tempo',
    rpcUrl: 'https://rpc.tempo.xyz',
    protocols: ['mpp'],
    tokens: {
      PathUSD: '0x20c0000000000000000000000000000000000000',
      USDC: '0x20C000000000000000000000b9537d11c60E8b50',
    },
  },
  'base-mainnet': {
    chainId: 8453,
    caip2: 'eip155:8453',
    name: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    protocols: ['x402'],
    tokens: { USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
  },
  'xrpl-testnet': {
    chainId: 0,
    caip2: 'xrpl:testnet',
    name: 'XRPL Testnet',
    rpcUrl: 'https://s.altnet.rippletest.net:51234',
    wsUrl: 'wss://s.altnet.rippletest.net:51233',
    protocols: ['xrpl'],
    tokens: { RLUSD: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', XRP: 'native' },
  },
  'xrpl-mainnet': {
    chainId: 0,
    caip2: 'xrpl:mainnet',
    name: 'XRPL Mainnet',
    rpcUrl: 'https://xrplcluster.com',
    wsUrl: 'wss://xrplcluster.com',
    protocols: ['xrpl'],
    tokens: { RLUSD: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De', XRP: 'native' },
  },
  'stellar-testnet': {
    chainId: 0,
    caip2: 'stellar:testnet',
    name: 'Stellar Testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    protocols: ['stellar-x402', 'stellar-mpp'],
    tokens: { USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA' },
    facilitator: 'https://channels.openzeppelin.com/x402/testnet',
  },
  'stellar-mainnet': {
    chainId: 0,
    caip2: 'stellar:pubnet',
    name: 'Stellar Mainnet',
    rpcUrl: 'https://soroban.stellar.org',
    protocols: ['stellar-x402', 'stellar-mpp'],
    tokens: { USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' },
    facilitator: 'https://channels.openzeppelin.com/x402',
  },
  'solana-mainnet': {
    chainId: 0,
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    name: 'Solana',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    protocols: ['x402-solana'],
    tokens: { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
  },
  'solana-devnet': {
    chainId: 0,
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    name: 'Solana Devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    protocols: ['x402-solana'],
    tokens: { USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
    facilitator: 'https://x402.org/facilitator',
  },
  'morph-mainnet': {
    chainId: 2818,
    caip2: 'eip155:2818',
    name: 'Morph',
    rpcUrl: 'https://rpc-quicknode.morphl2.io',
    protocols: ['morph-x402'],
    tokens: {
      USDC: '0xe34c91815d7fc18A9e2148bcD4241d0a5848b693',
      USDT0: '0xe7cd86e13AC4309349F30B3435a9d337750fC82D',
      BGB: '0x389C08Bc23A7317000a1FD76c7c5B0cb0b4640b5',
    },
    facilitator: 'https://morph-rails.morph.network/x402',
  },
  'morph-hoodi-testnet': {
    chainId: 2910,
    caip2: 'eip155:2910',
    name: 'Morph Hoodi Testnet',
    rpcUrl: 'https://rpc-quicknode-holesky.morphl2.io',
    protocols: ['morph-x402'],
    tokens: {
      USDC: '0xe34c91815d7fc18A9e2148bcD4241d0a5848b693',
    },
    facilitator: 'https://morph-rails-hoodi.morph.network/x402',
  },
};

export function getChain(key: ChainKey): ChainConfig {
  return CHAINS[key];
}

export function getChainsForProtocol(chains: ChainKey[], protocol: string): ChainKey[] {
  return chains.filter((c) => CHAINS[c]?.protocols.includes(protocol));
}
