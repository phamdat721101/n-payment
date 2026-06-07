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
    // v0.17: Testnet USDC is faucet-issued. Override via goat.usdcOverride if your fixture differs.
    // Real liquidity for OKU PegBTC↔USDC pools and LayerZero OFT testnet endpoint may be partial —
    // the acquisition router auto-falls-back to MockSwap/MockOft/MockBridge adapters in 'testnet-mock' mode.
    tokens: { USDC: '0x0000000000000000000000000000000000000000', USDT: '0x0000000000000000000000000000000000000000', WBTC: '0x0000000000000000000000000000000000000000', PegBTC: '0xbC10000000000000000000000000000000000000' },
    facilitator: 'https://api.x402.goat.network',
  },
  'goat-mainnet': {
    chainId: 2345,
    caip2: 'eip155:2345',
    name: 'GOAT Network',
    rpcUrl: 'https://rpc.goat.network',
    protocols: ['goat'],
    // v0.17: USDC/USDT on GOAT mainnet arrive via LayerZero V2 OFT and cross-chain x402 settlement.
    // Override via goat.usdcOverride if your deployment differs from the canonical OFT address.
    // PegBTC = WGBTC (gas token wrapper) at 0xbC10…0000. GOAT Token at 0xbC10…0001. Multicall3
    // for batch reads at 0xcA11bde05977b3631167028862bE2a173976CA11.
    tokens: { USDC: '0x0000000000000000000000000000000000000000', USDT: '0x0000000000000000000000000000000000000000', PegBTC: '0xbC10000000000000000000000000000000000000', GOAT: '0xbC10000000000000000000000000000000000001' },
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
    protocols: ['x402', 'wormhole-ntt', 'rlusd-exact'],
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      // v0.22 — RLUSD on Base via Wormhole NTT (burn-and-mint, threshold=1).
      RLUSD: '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    },
    facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
  },
  'bnb-mainnet': {
    chainId: 56,
    caip2: 'eip155:56',
    name: 'BNB Chain',
    rpcUrl: 'https://bsc-dataseed.binance.org',
    protocols: ['x402'],
    tokens: { USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
    facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
  },
  'bnb-testnet': {
    chainId: 97,
    caip2: 'eip155:97',
    name: 'BNB Testnet',
    rpcUrl: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    protocols: ['x402'],
    tokens: { USDC: '0x64544969ed7EBf5f083679233325356EbE738930' },
    facilitator: 'https://x402.org/facilitator',
  },
  'xrpl-testnet': {
    chainId: 0,
    caip2: 'xrpl:testnet',
    name: 'XRPL Testnet',
    rpcUrl: 'https://s.altnet.rippletest.net:51234',
    wsUrl: 'wss://s.altnet.rippletest.net:51233',
    protocols: ['xrpl'],
    // Per Ripple docs the testnet RLUSD issuer differs from mainnet — see src/xrpl/utils.ts RLUSD_ISSUERS.
    tokens: { RLUSD: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', XRP: 'native' },
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
  // v0.18: Morph Hoodi testnet — RPC + USDC refreshed against docs.morph.network (2026-05).
  // USDC is the operator-supplied test token (overrides the docs' L2USDC for our e2e flow).
  // Default facilitator is the local custom facilitator; override at runtime via morph.facilitatorUrl.
  'morph-hoodi-testnet': {
    chainId: 2910,
    caip2: 'eip155:2910',
    name: 'Morph Hoodi Testnet',
    rpcUrl: 'https://rpc-hoodi.morph.network',
    protocols: ['morph-x402'],
    tokens: {
      USDC: '0x7433b41C6c5e1d58D4Da99483609520255ab661B',
    },
    facilitator: 'http://localhost:4040/x402',
  },
  'creditcoin-mainnet': {
    chainId: 102030,
    caip2: 'eip155:102030',
    name: 'Creditcoin',
    rpcUrl: 'https://mainnet3.creditcoin.network',
    protocols: ['spacerouter'],
    tokens: {
      SPACE: '0x7ab7C6A935Ab2D1437398790C9C0660af62A80b9',
      // Native gas token. Use the zero-address sentinel — wallet flows treat this as native CTC.
      CTC: '0x0000000000000000000000000000000000000000',
    },
    facilitator: 'https://gateway.spacerouter.org',
  },
  'creditcoin-testnet': {
    chainId: 102031,
    caip2: 'eip155:102031',
    name: 'Creditcoin CC3 Testnet',
    rpcUrl: 'https://rpc.cc3-testnet.creditcoin.network',
    protocols: ['spacerouter'],
    tokens: {
      // SPC = testnet equivalent of SPACE. Address overridable via SpaceRouterConfig.tokenAddress.
      SPC: '0x0000000000000000000000000000000000000000',
      CTC: '0x0000000000000000000000000000000000000000',
    },
    facilitator: 'https://gateway.spacerouter.org',
  },
  // v0.15: Flare Coston2 testnet for FXRP direct-minting bridge.
  // v0.19: extends to flare-x402 (MockUSDT0 + X402Facilitator) and gasless FXRP forwarder.
  // FXRP token + AssetManager are resolved on-chain via FlareContractRegistry —
  // never hardcoded. MockUSDT0 + X402Facilitator + GaslessPaymentForwarder are
  // caller-deployed (see examples/flare-payments-demo.ts deploy mode); the zero-
  // address slots below are filled by user via FlareConfig.{x402,gasless}.
  'flare-coston2-testnet': {
    chainId: 114,
    caip2: 'eip155:114',
    name: 'Flare Coston2 Testnet',
    rpcUrl: 'https://coston2-api.flare.network/ext/C/rpc',
    protocols: ['flare-fxrp', 'flare-x402'],
    tokens: {
      FXRP: '0x0000000000000000000000000000000000000000',     // resolved on-chain via registry
      MockUSDT0: '0x0000000000000000000000000000000000000000', // caller-supplied (deploy helper)
    },
  },
  // v0.19: Songbird canary (chainId 19). FlareContractRegistry root is identical
  // to Coston2/mainnet, so FXRP + AssetManager auto-resolve once FAssets ships there.
  'flare-songbird-mainnet': {
    chainId: 19,
    caip2: 'eip155:19',
    name: 'Songbird Mainnet',
    rpcUrl: 'https://songbird-api.flare.network/ext/C/rpc',
    protocols: ['flare-fxrp', 'flare-x402'],
    tokens: {
      FXRP: '0x0000000000000000000000000000000000000000',
      MockUSDT0: '0x0000000000000000000000000000000000000000',
    },
  },
  // v0.19: Flare mainnet (chainId 14). FXRP-on-mainnet x402 awaits production
  // FXRP gaining EIP-3009 (per Flare docs); gasless forwarder is usable today.
  'flare-mainnet': {
    chainId: 14,
    caip2: 'eip155:14',
    name: 'Flare Mainnet',
    rpcUrl: 'https://flare-api.flare.network/ext/C/rpc',
    protocols: ['flare-fxrp', 'flare-x402'],
    tokens: {
      FXRP: '0x0000000000000000000000000000000000000000',
      MockUSDT0: '0x0000000000000000000000000000000000000000',
    },
  },
  // ── v0.22 — RLUSD multichain via Wormhole NTT ────────────────────────────
  // All 5 EVM chains share the same NttManager (0x2a71afb1...) and Transceiver
  // (0x7B17Afd3...) per Wormhole CREATE2 deterministic addressing. Source:
  // github.com/wormhole-foundation/connect-w/blob/62f8216/src/deployments/RLUSD.json
  'ethereum-mainnet': {
    chainId: 1,
    caip2: 'eip155:1',
    name: 'Ethereum',
    rpcUrl: 'https://eth.llamarpc.com',
    protocols: ['x402', 'wormhole-ntt', 'rlusd-exact'],
    tokens: {
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      RLUSD: '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD',
    },
  },
  'optimism-mainnet': {
    chainId: 10,
    caip2: 'eip155:10',
    name: 'Optimism',
    rpcUrl: 'https://mainnet.optimism.io',
    protocols: ['x402', 'wormhole-ntt', 'rlusd-exact'],
    tokens: {
      USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      RLUSD: '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    },
  },
  'ink-mainnet': {
    chainId: 57073,
    caip2: 'eip155:57073',
    name: 'Ink',
    rpcUrl: 'https://rpc-gel.inkonchain.com',
    protocols: ['x402', 'wormhole-ntt', 'rlusd-exact'],
    tokens: {
      USDC: '0xF1815bd50389c46847f0Bda824eC8da914045D14',
      RLUSD: '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    },
  },
  'unichain-mainnet': {
    chainId: 130,
    caip2: 'eip155:130',
    name: 'Unichain',
    rpcUrl: 'https://mainnet.unichain.org',
    protocols: ['x402', 'wormhole-ntt', 'rlusd-exact'],
    tokens: {
      USDC: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
      RLUSD: '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    },
  },
  // ── v0.23 — Initia (Cosmos-SDK L1 + Interwoven Rollups) ─────────────────
  // chainId is set to 0 because Cosmos-SDK chains identify by string id (caip2).
  // Token addresses are denoms (string) — populated at runtime from INITIA_ASSETS.
  // RPC/REST URLs follow Initia's documented public endpoints; override via InitiaConfig.
  'initia-mainnet': {
    chainId: 0,
    caip2: 'cosmos:interwoven-1',
    name: 'Initia',
    rpcUrl: 'https://rpc.initia.xyz',
    protocols: ['cosmos-msgsend'],
    tokens: { INIT: 'uinit' },
  },
  'initia-testnet': {
    chainId: 0,
    caip2: 'cosmos:initiation-2',
    name: 'Initia Testnet',
    rpcUrl: 'https://rpc.initiation-2.initia.xyz',
    protocols: ['cosmos-msgsend'],
    tokens: { INIT: 'uinit' },
  },
};

export function getChain(key: ChainKey): ChainConfig {
  return CHAINS[key];
}

export function getChainsForProtocol(chains: ChainKey[], protocol: string): ChainKey[] {
  return chains.filter((c) => CHAINS[c]?.protocols.includes(protocol));
}
