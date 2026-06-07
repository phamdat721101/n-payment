// v0.22 — Wormhole NTT public surface for n-payment.
//
// Registry + preflight (PRD-A): RLUSD_NTT_DEPLOYMENTS, canBridgeRlusd
// Client + factory (PRD-B):     WormholeNttClient, createDefaultWormholeNttBridgeFactory
// Types:                        WormholeChainName, NttDeployment, EvmSigner, ...

export {
  RLUSD_NTT_DEPLOYMENTS,
  CHAIN_KEY_TO_WH,
  whChainFromKey,
  chainKeyFromWh,
  canBridgeRlusd,
} from './deployments.js';

export {
  WormholeNttClient,
  createDefaultWormholeNttBridgeFactory,
} from './ntt-client.js';

export type {
  WormholeChainName,
  NttDeployment,
  CanBridgeResult,
  EvmSigner,
  NttBridgeRequest,
  NttBridgeResult,
  NttTransferRequest,
  NttTransferReceipt,
  WormholeNttBridge,
  WormholeNttBridgeFactory,
  WormholeNttClientConfig,
  WormholeNttAdapterOptions,
} from './types.js';
