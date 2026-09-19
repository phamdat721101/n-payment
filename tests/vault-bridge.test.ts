import { describe, it, expect, vi } from 'vitest';
import { VaultPaymentBridge } from '../src/vault/vault-bridge.js';

describe('VaultPaymentBridge — opt-in, no-op when vault not configured', () => {
  it('resolveSettlementSource() returns "direct-wallet" (pass-through) when no vault config is provided', async () => {
    const bridge = new VaultPaymentBridge(undefined);
    const decision = await bridge.resolveSettlementSource(1_000_000n);
    expect(decision.source).toBe('direct-wallet');
  });

  it('executeUnbondedPayment() throws a clear, typed error if called without a configured vault (never silently no-ops on an actual payment attempt)', async () => {
    const bridge = new VaultPaymentBridge(undefined);
    await expect(bridge.executeUnbondedPayment(1_000_000n, '0x1111111111111111111111111111111111111111')).rejects.toThrow(/no vault is configured/i);
  });
});

describe('VaultPaymentBridge — opt-in path, exercised when vault IS configured', () => {
  function makeMockWalletClient(txHash: `0x${string}` = '0xabc') {
    return { writeContract: vi.fn(async () => txHash) };
  }

  it('resolveSettlementSource() returns "vault" when a vault address is configured', async () => {
    const bridge = new VaultPaymentBridge({
      vaultAddress: '0x1111111111111111111111111111111111111111',
      client: {} as any,
      wallet: makeMockWalletClient() as any,
    });
    const decision = await bridge.resolveSettlementSource(1_000_000n);
    expect(decision.source).toBe('vault');
    expect(decision.vaultAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('executeUnbondedPayment() calls the real instantWithdrawForPayment ABI function on the configured vault', async () => {
    const mockWallet = makeMockWalletClient('0xdeadbeef' as `0x${string}`);
    const bridge = new VaultPaymentBridge({
      vaultAddress: '0x1111111111111111111111111111111111111111',
      client: {} as any,
      wallet: mockWallet as any,
    });

    const txHash = await bridge.executeUnbondedPayment(1_000_000n, '0x2222222222222222222222222222222222222222');

    expect(txHash).toBe('0xdeadbeef');
    expect(mockWallet.writeContract).toHaveBeenCalledTimes(1);
    const call = mockWallet.writeContract.mock.calls[0][0];
    expect(call.functionName).toBe('instantWithdrawForPayment');
    expect(call.address).toBe('0x1111111111111111111111111111111111111111');
    expect(call.args).toEqual([1_000_000n, '0x2222222222222222222222222222222222222222']);
  });
});
