/**
 * v0.31 — ProtocolAdapterRegistry for OnchainLendingResearchService.
 * Maps (protocol, chain) -> a registered ProtocolAdapter instance.
 * Throws a typed, actionable error for unsupported combos (CHAOS-01 in
 * PRD-07) rather than silently defaulting to some fallback adapter.
 */
import type { ProtocolAdapter } from './interface.js';
import type { LendingProtocolType, ResearchChainKey } from '../types.js';
import { UnsupportedProtocolChainError } from '../errors.js';

export class ProtocolAdapterRegistry {
  private readonly adapters = new Map<LendingProtocolType, ProtocolAdapter>();

  public register(adapter: ProtocolAdapter): void {
    this.adapters.set(adapter.protocol, adapter);
  }

  public getAdapter(protocol: LendingProtocolType, chain: ResearchChainKey): ProtocolAdapter {
    const adapter = this.adapters.get(protocol);
    if (!adapter) {
      throw new UnsupportedProtocolChainError(protocol, chain);
    }
    if (!adapter.supportedChains.includes(chain)) {
      throw new UnsupportedProtocolChainError(protocol, chain);
    }
    return adapter;
  }

  public registeredProtocols(): LendingProtocolType[] {
    return Array.from(this.adapters.keys());
  }
}
