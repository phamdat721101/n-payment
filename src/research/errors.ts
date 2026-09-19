import { NPaymentError } from '../errors.js';

/**
 * v0.31 — OnchainLendingResearchService error hierarchy.
 * Extends the SDK-wide NPaymentError base class (see src/errors.ts) rather
 * than inventing a parallel hierarchy, matching this repo's existing
 * convention for GOAT_* / OWS_* error codes.
 */

export class InvalidSubjectIdentifierError extends NPaymentError {
  override name = 'InvalidSubjectIdentifierError';
  constructor(message: string, hint?: string) {
    super(message, 'RESEARCH_INVALID_SUBJECT_IDENTIFIER', hint ?? 'Provide a valid 0x-prefixed address or 32-byte market/vault identifier for the target protocol.');
  }
}

export class UnsupportedProtocolChainError extends NPaymentError {
  override name = 'UnsupportedProtocolChainError';
  constructor(protocol: string, chain: string) {
    super(
      `No adapter registered for protocol "${protocol}" on chain "${chain}"`,
      'RESEARCH_UNSUPPORTED_PROTOCOL_CHAIN',
      'Check ProtocolAdapterRegistry.getAdapter()\'s supported chain list for this protocol, or pick a different chain.',
    );
  }
}

export class CyclicCausalGraphError extends NPaymentError {
  override name = 'CyclicCausalGraphError';
  constructor(message = 'Causal DAG contains a cycle and cannot be topologically sorted') {
    super(message, 'RESEARCH_CYCLIC_CAUSAL_GRAPH', 'Self-liquidation / circular MEV bot traces must be broken into chronological timeline edges before serialization (see CHAOS-04).');
  }
}

export class LiveRpcCallFailedError extends NPaymentError {
  override name = 'LiveRpcCallFailedError';
  constructor(protocol: string, cause?: string) {
    super(
      `Live RPC call failed for protocol "${protocol}"${cause ? `: ${cause}` : ''}`,
      'RESEARCH_LIVE_RPC_CALL_FAILED',
      'Public RPC endpoints are rate-limited/best-effort. Retry with backoff, or set FORK_RPC_URL / a chain-specific RPC env var to a dedicated provider.',
    );
  }
}
