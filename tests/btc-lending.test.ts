import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { BtcLendingVault } from '../src/goat/lending.js';
import { OWSWallet } from '../src/ows/wallet.js';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function mockOwsSuccess(data: unknown) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(null, JSON.stringify({ ok: true, data }), '');
    return {} as any;
  });
}

describe('BtcLendingVault', () => {
  const wallet = new OWSWallet({ wallet: 'test' });
  const config = { vaultAddress: '0xVAULT123' };

  beforeEach(() => { vi.clearAllMocks(); });

  it('estimateCollateral calculates 150% ratio by default', () => {
    const vault = new BtcLendingVault(wallet, config);
    expect(vault.estimateCollateral('10000')).toBe('15000');
  });

  it('estimateCollateral respects custom ratio', () => {
    const vault = new BtcLendingVault(wallet, { ...config, collateralRatio: 200 });
    expect(vault.estimateCollateral('10000')).toBe('20000');
  });

  it('lockAndBorrow calls OWS signTransaction with vault address', async () => {
    mockOwsSuccess({ signedTx: '0xSIGNED', txHash: '0x' + 'a'.repeat(64) });
    const vault = new BtcLendingVault(wallet, config);
    const txHash = await vault.lockAndBorrow('15000', '10000', 2345);
    expect(txHash).toBe('0x' + 'a'.repeat(64));
  });

  it('repayAndUnlock calls OWS signTransaction', async () => {
    mockOwsSuccess({ signedTx: '0xSIGNED', txHash: '0x' + 'b'.repeat(64) });
    const vault = new BtcLendingVault(wallet, config);
    const txHash = await vault.repayAndUnlock('0x' + 'a'.repeat(64), 2345);
    expect(txHash).toBe('0x' + 'b'.repeat(64));
  });

  it('lockAndBorrow throws on OWS failure', async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('exit 1'), '', 'insufficient balance');
      return {} as any;
    });
    const vault = new BtcLendingVault(wallet, config);
    await expect(vault.lockAndBorrow('15000', '10000', 2345)).rejects.toThrow(/balance/i);
  });
});

import { GoatAdapter } from '../src/adapters/goat.js';

describe('GoatAdapter with BTC lending', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('constructs with optional lending vault', () => {
    const w = new OWSWallet({ wallet: 'test' });
    const vault = new BtcLendingVault(w, { vaultAddress: '0xV' });
    const adapter = new GoatAdapter(
      { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      w, vault,
    );
    expect(adapter.protocol).toBe('goat');
  });

  it('constructs without lending vault (backward compatible)', () => {
    const w = new OWSWallet({ wallet: 'test' });
    const adapter = new GoatAdapter(
      { apiKey: 'k', apiSecret: 's', merchantId: 'm' },
      w,
    );
    expect(adapter.protocol).toBe('goat');
  });
});