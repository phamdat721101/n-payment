import { describe, it, expect, vi } from 'vitest';
import { SiloAdapter, SILO_FACTORY_ADDRESSES } from '../src/research/adapters/silo.js';

describe('SiloAdapter — offline (mocked viem client)', () => {
  it('exposes real, verified per-chain SiloFactory (v2, not stale v1/stale-methodology) addresses', () => {
    // Verified via DefiLlama's ACTUAL adapter source code (configV2 object
    // in DefiLlama-Adapters/projects/silo-v2/index.js) during implementation
    // — NOT the page-level methodology string, which quotes a DIFFERENT,
    // stale address (0xa42001d6...) that has zero contract code on Ethereum
    // mainnet (confirmed via a live eth_getCode call). devdocs.silo.finance's
    // addresses were separately found to be stale v1 architecture terms
    // (SiloRepository / PriceProvidersRepository) and also not reused here.
    expect(SILO_FACTORY_ADDRESSES['ethereum-mainnet']).toBe('0x22a3cF6149bFa611bAFc89Fd721918EC3Cf7b581');
    expect(SILO_FACTORY_ADDRESSES['arbitrum-one']).toBe('0x384DC7759d35313F0b567D42bf2f611B285B657C');
  });

  it('requires vault_address as the subject type (no market-id singleton exists for Silo v2)', async () => {
    const adapter = new SiloAdapter({} as any, 'ethereum-mainnet');
    await expect(
      adapter.fetchPositionContext({ type: 'market_id', identifier: '0x1111111111111111111111111111111111111111' }),
    ).rejects.toThrow(/vault_address/i);
  });

  it('verifies factory provenance via isSilo() before trusting a caller-supplied vault address', async () => {
    const siloAddr = '0x3333333333333333333333333333333333333333' as `0x${string}`;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isSilo') return false; // NOT a real Silo per the factory
      throw new Error('should not read totalAssets for an unverified address');
    });
    const mockClient = { readContract } as any;
    const adapter = new SiloAdapter(mockClient, 'ethereum-mainnet');

    await expect(adapter.fetchPositionContext({ type: 'vault_address', identifier: siloAddr })).rejects.toThrow(/not a known Silo/i);
  });

  it('normalizes totalAssets()/totalBorrows() reads into a PositionHealthSnapshot for a provenance-verified Silo', async () => {
    const siloAddr = '0x4444444444444444444444444444444444444444' as `0x${string}`;
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isSilo') return true;
      if (functionName === 'totalAssets') return 900_000_000_000n;
      if (functionName === 'totalBorrows') return 540_000_000_000n;
      throw new Error(`unexpected functionName: ${functionName}`);
    });
    const mockClient = { readContract } as any;
    const adapter = new SiloAdapter(mockClient, 'ethereum-mainnet');

    const snapshot = await adapter.fetchPositionContext({ type: 'vault_address', identifier: siloAddr });

    expect(snapshot.protocol).toBe('silo-v2');
    expect(snapshot.utilizationRate).toBeCloseTo(540_000 / 900_000, 3);
    expect(snapshot.totalCollateralUsd).toBeGreaterThan(0);
  });
});
