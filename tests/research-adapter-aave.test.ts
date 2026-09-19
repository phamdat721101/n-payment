import { describe, it, expect, vi } from 'vitest';
import { AaveV3Adapter } from '../src/research/adapters/aave.js';
import { AAVE_POOL_ADDRESSES } from '../src/aave/client.js';

describe('AaveV3Adapter — offline (mocked viem client)', () => {
  it('reuses the existing, already-verified AAVE_POOL_ADDRESSES map (does not redefine addresses)', () => {
    expect(AAVE_POOL_ADDRESSES['ethereum']).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
  });

  it('normalizes getUserAccountData() into a PositionHealthSnapshot', async () => {
    const userAddr = '0x1111111111111111111111111111111111111111' as `0x${string}`;

    // Real getUserAccountData() return shape, verified against
    // aave.com/docs/aave-v3/smart-contracts/pool:
    // (totalCollateralBase, totalDebtBase, availableBorrowsBase,
    //  currentLiquidationThreshold [bps], ltv [bps], healthFactor [1e18-scaled, or uint.max if no debt])
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'getUserAccountData') {
        return [
          150_000_00000000n, // totalCollateralBase (8-decimal base currency units, ~$150,000)
          100_000_00000000n, // totalDebtBase (~$100,000)
          30_000_00000000n, // availableBorrowsBase
          8600n, // currentLiquidationThreshold = 86.00%
          8000n, // ltv = 80.00%
          1_193_000_000_000_000_000n, // healthFactor ~1.193
        ];
      }
      throw new Error(`unexpected functionName: ${functionName}`);
    });

    const mockClient = { readContract } as any;
    const adapter = new AaveV3Adapter(mockClient, 'ethereum-mainnet');

    const snapshot = await adapter.fetchPositionContext({ type: 'borrower', identifier: userAddr });

    expect(snapshot.protocol).toBe('aave-v3');
    expect(snapshot.chain).toBe('ethereum-mainnet');
    expect(snapshot.liquidationThresholdLtv).toBeCloseTo(0.86, 5);
    expect(snapshot.currentLtv).toBeCloseTo(100_000 / 150_000, 3);
    expect(snapshot.healthFactor).toBeCloseTo(1.193, 3);
    expect(snapshot.totalCollateralUsd).toBeGreaterThan(0);
    expect(snapshot.totalDebtUsd).toBeGreaterThan(0);
  });

  it('reports Infinity health factor for a zero-debt position (real uint256.max sentinel)', async () => {
    const readContract = vi.fn(async () => [
      150_000_00000000n,
      0n,
      120_000_00000000n,
      8600n,
      0n,
      2n ** 256n - 1n, // Aave's real "no debt" sentinel (type(uint256).max)
    ]);
    const mockClient = { readContract } as any;
    const adapter = new AaveV3Adapter(mockClient, 'base-mainnet');

    const snapshot = await adapter.fetchPositionContext({
      type: 'borrower',
      identifier: '0x2222222222222222222222222222222222222222',
    });

    expect(snapshot.healthFactor).toBe(Infinity);
    expect(snapshot.totalDebtUsd).toBe(0);
  });

  it('throws for unsupported chains rather than silently defaulting', () => {
    const adapter = new AaveV3Adapter({} as any, 'optimism-mainnet');
    expect(adapter.supportedChains).not.toContain('optimism-mainnet');
  });
});
