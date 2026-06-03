/**
 * n-payment/spacerouter — public surface for the SpaceRouter (SpaceCoin) integration.
 *
 * Two import paths supported:
 *   import { SpaceRouterClient } from 'n-payment';            // re-exported from root
 *   import { SpaceRouterClient } from 'n-payment/spacerouter'; // tree-shakable subpath
 */
export type { SpaceRouterSigner, SpaceRouterReceipt } from './signer.js';
export {
  KeypairSpaceRouterSigner, OWSSpaceRouterSigner, BrowserSpaceRouterSigner,
  spaceRouterDomain, SPACEROUTER_RECEIPT_TYPES,
} from './signer.js';

export type { EscrowClientConfig, WithdrawalRequest } from './escrow.js';
export {
  SpaceRouterEscrowClient, EscrowEmptyError, WithdrawalLockedError, WithdrawalAlreadyPendingError,
  InvalidAmountError,
  parseSpace, formatSpace, SPACE_DECIMALS,
  ERC20_ABI, ESCROW_ABI,
} from './escrow.js';

export type {
  GatewayChallenge, GatewayClientConfig, ReceiptSchedulerConfig,
  SignedReceiptEnvelope, SyncResult,
} from './gateway.js';
export {
  SpaceRouterGatewayClient, SpaceRouterReceiptScheduler,
} from './gateway.js';

export type { SpaceRouterClientConfig, RoutedResponse } from './client.js';
export { SpaceRouterClient, SpaceRouterPeerDepMissingError } from './client.js';

export { SpaceRouterAdapter } from '../adapters/spacerouter.js';
