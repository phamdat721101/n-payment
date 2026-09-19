import { describe, it, expect, vi } from 'vitest';
import { ProtocolAdapterRegistry } from '../src/research/adapters/registry.js';
import { LendingResearchClient } from '../src/research/client.js';
import { UnsupportedProtocolChainError } from '../src/research/errors.js';

function makeMockAdapter(protocol: string, chains: string[]) {
  return {
    protocol,
    supportedChains: chains,
    fetchPositionContext: vi.fn(async (subject: any) => ({
      protocol,
      chain: chains[0],
      subjectIdentifier: subject.identifier,
      totalCollateralUsd: 100_000,
      totalDebtUsd: 50_000,
      currentLtv: 0.5,
      liquidationThresholdLtv: 0.8,
      healthFactor: 1.6,
      borrowApy: 0.05,
      supplyApy: 0.03,
    })),
    fetchRecentLiquidationEvents: vi.fn(async () => []),
  };
}

describe('ProtocolAdapterRegistry', () => {
  it('registers and retrieves an adapter for a supported protocol+chain combo', () => {
    const registry = new ProtocolAdapterRegistry();
    const mockAdapter = makeMockAdapter('morpho-blue', ['ethereum-mainnet']);
    registry.register(mockAdapter as any);

    const resolved = registry.getAdapter('morpho-blue', 'ethereum-mainnet');
    expect(resolved).toBe(mockAdapter);
  });

  it('throws a typed UnsupportedProtocolChainError for an unregistered protocol', () => {
    const registry = new ProtocolAdapterRegistry();
    expect(() => registry.getAdapter('morpho-blue', 'ethereum-mainnet')).toThrow(UnsupportedProtocolChainError);
  });

  it('throws a typed UnsupportedProtocolChainError for a registered protocol on an unsupported chain', () => {
    const registry = new ProtocolAdapterRegistry();
    registry.register(makeMockAdapter('morpho-blue', ['ethereum-mainnet']) as any);
    expect(() => registry.getAdapter('morpho-blue', 'arbitrum-one')).toThrow(UnsupportedProtocolChainError);
  });
});

describe('LendingResearchClient — facade', () => {
  it('validates the request, dispatches to the right adapter, and returns a normalized snapshot', async () => {
    const registry = new ProtocolAdapterRegistry();
    const mockAdapter = makeMockAdapter('morpho-blue', ['ethereum-mainnet']);
    registry.register(mockAdapter as any);

    const client = new LendingResearchClient(registry);
    const snapshot = await client.auditLendingPosition({
      targetProtocol: 'morpho-blue',
      targetChain: 'ethereum-mainnet',
      targetSubject: { type: 'market_id', identifier: '0xfc91948b556d7529ad6f5318825286ed2c34d862427b4832817e880a7edbd160' },
    });

    expect(snapshot.protocol).toBe('morpho-blue');
    expect(snapshot.healthFactor).toBeCloseTo(1.6, 5);
    expect(mockAdapter.fetchPositionContext).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed request before ever touching the adapter registry', async () => {
    const registry = new ProtocolAdapterRegistry();
    const mockAdapter = makeMockAdapter('morpho-blue', ['ethereum-mainnet']);
    registry.register(mockAdapter as any);
    const client = new LendingResearchClient(registry);

    await expect(
      client.auditLendingPosition({
        targetProtocol: 'morpho-blue',
        targetChain: 'ethereum-mainnet',
        targetSubject: { type: 'market_id', identifier: '0xbad' },
      } as any),
    ).rejects.toThrow();
    expect(mockAdapter.fetchPositionContext).not.toHaveBeenCalled();
  });

  it('surfaces the typed UnsupportedProtocolChainError for a valid-shaped request against an unregistered protocol', async () => {
    const registry = new ProtocolAdapterRegistry();
    const client = new LendingResearchClient(registry);

    await expect(
      client.auditLendingPosition({
        targetProtocol: 'euler-v2',
        targetChain: 'ethereum-mainnet',
        targetSubject: { type: 'vault_address', identifier: '0x1111111111111111111111111111111111111111' },
      }),
    ).rejects.toThrow(UnsupportedProtocolChainError);
  });

  it('rejects targetProtocol="auto" rather than silently guessing a protocol (no adapter is ever registered under "auto")', async () => {
    const registry = new ProtocolAdapterRegistry();
    registry.register(makeMockAdapter('morpho-blue', ['ethereum-mainnet']) as any);
    const client = new LendingResearchClient(registry);

    await expect(
      client.auditLendingPosition({
        targetProtocol: 'auto',
        targetChain: 'ethereum-mainnet',
        targetSubject: { type: 'market_id', identifier: '0x1111111111111111111111111111111111111111' },
      }),
    ).rejects.toThrow(UnsupportedProtocolChainError);
  });
});
