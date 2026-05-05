import { describe, it, expect, vi } from 'vitest';
import { BtcLendingVault } from '../src/goat/lending.js';
import { OWSWallet } from '../src/ows/wallet.js';
import { GoatAdapter } from '../src/adapters/goat.js';

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('BtcLendingVault', () => {
  const config = { vaultAddress: '0xVAULT123' };

  it('estimateCollateral calculates 150% ratio by default', () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const vault = new BtcLendingVault(wallet, config);
    expect(vault.estimateCollateral('10000')).toBe('15000');
  });

  it('estimateCollateral respects custom ratio', () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const vault = new BtcLendingVault(wallet, { ...config, collateralRatio: 200 });
    expect(vault.estimateCollateral('10000')).toBe('20000');
  });

  it('lockAndBorrow calls signTransaction with vault address', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const vault = new BtcLendingVault(wallet, config);
    // Mock signTransaction to avoid real RPC calls
    const mockResult = { txHash: '0x' + 'a'.repeat(64), blockNumber: 1n };
    vi.spyOn(wallet, 'signTransaction').mockResolvedValue(mockResult);
    const txHash = await vault.lockAndBorrow('15000', '10000', 84532);
    expect(txHash).toBe('0x' + 'a'.repeat(64));
    expect(wallet.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xVAULT123' }),
      84532,
    );
  });

  it('repayAndUnlock calls signTransaction', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const vault = new BtcLendingVault(wallet, config);
    const mockResult = { txHash: '0x' + 'b'.repeat(64), blockNumber: 2n };
    vi.spyOn(wallet, 'signTransaction').mockResolvedValue(mockResult);
    const txHash = await vault.repayAndUnlock('0x' + 'a'.repeat(64), 84532);
    expect(txHash).toBe('0x' + 'b'.repeat(64));
  });

  it('lockAndBorrow propagates errors', async () => {
    const wallet = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const vault = new BtcLendingVault(wallet, config);
    vi.spyOn(wallet, 'signTransaction').mockRejectedValue(new Error('RPC error'));
    await expect(vault.lockAndBorrow('15000', '10000', 84532)).rejects.toThrow('RPC error');
  });
});

describe('GoatAdapter with BTC lending', () => {
  it('constructs with optional lending vault', () => {
    const w = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const vault = new BtcLendingVault(w, { vaultAddress: '0xV' });
    const adapter = new GoatAdapter(
      { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      w, vault,
    );
    expect(adapter.protocol).toBe('goat');
  });

  it('constructs without lending vault', () => {
    const w = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const adapter = new GoatAdapter(
      { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      w,
    );
    expect(adapter.protocol).toBe('goat');
  });
});
