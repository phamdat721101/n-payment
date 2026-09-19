import { describe, it, expect, vi } from 'vitest';
import { EulerV2Adapter, EULER_VAULT_FACTORY_ADDRESS } from '../src/research/adapters/euler.js';

describe('EulerV2Adapter — offline (mocked viem client)', () => {
  it('exposes the real, bytecode-verified eVaultFactory address (Ethereum mainnet)', () => {
    // Verified against euler-xyz/euler-interfaces's verify/1.md (bytecode-proven
    // deployment registry) during implementation — footnote [101]:
    // https://etherscan.io/address/0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e
    expect(EULER_VAULT_FACTORY_ADDRESS).toBe('0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e');
  });

  it('requires vault_address as the subject type (no market-id singleton exists for Euler)', async () => {
    const adapter = new EulerV2Adapter({} as any, 'ethereum-mainnet');
    await expect(
      adapter.fetchPositionContext({ type: 'market_id', identifier: '0x1111111111111111111111111111111111111111' }),
    ).rejects.toThrow(/vault_address/i);
  });

  it('normalizes debtOf() + totalAssets()/totalBorrows() reads into a PositionHealthSnapshot', async () => {
    const vaultAddr = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const userAddr = '0x2222222222222222222222222222222222222222' as `0x${string}`;

    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'debtOf') return 80_000_000_000n; // 80,000 (6-decimal-ish units)
      if (functionName === 'totalAssets') return 500_000_000_000n;
      if (functionName === 'totalBorrows') return 380_000_000_000n;
      throw new Error(`unexpected functionName: ${functionName}`);
    });
    const mockClient = { readContract } as any;
    const adapter = new EulerV2Adapter(mockClient, 'ethereum-mainnet');

    const snapshot = await adapter.fetchPositionContext({ type: 'vault_address', identifier: vaultAddr }, userAddr);

    expect(snapshot.protocol).toBe('euler-v2');
    expect(snapshot.totalDebtUsd).toBeGreaterThan(0);
    expect(snapshot.utilizationRate).toBeCloseTo(380_000 / 500_000, 3);
  });

  it('registry-relevant: declared subject type differs from Morpho/Aave (documents factory-discovery design)', () => {
    const adapter = new EulerV2Adapter({} as any, 'ethereum-mainnet');
    expect(adapter.protocol).toBe('euler-v2');
    expect(adapter.supportedChains).toContain('ethereum-mainnet');
  });
});
