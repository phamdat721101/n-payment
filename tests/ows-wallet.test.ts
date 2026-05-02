import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { OWSWallet } from '../src/ows/wallet.js';
import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function mockOwsSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(null, stdout, '');
    return {} as any;
  });
}

function mockOwsError(stderr: string) {
  mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb(new Error('exit 1'), '', stderr);
    return {} as any;
  });
}

describe('OWSWallet', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('getAddress returns address from ows output', async () => {
    mockOwsSuccess(JSON.stringify({ ok: true, data: { address: '0xABC123def456789012345678901234567890abcd' } }));
    const w = new OWSWallet({ wallet: 'test' });
    const addr = await w.getAddress(84532);
    expect(addr).toBe('0xABC123def456789012345678901234567890abcd');
  });

  it('signTransaction returns signed tx', async () => {
    mockOwsSuccess(JSON.stringify({ ok: true, data: { signedTx: '0xSIGNED', txHash: '0x' + 'a'.repeat(64) } }));
    const w = new OWSWallet({ wallet: 'test' });
    const result = await w.signTransaction({ to: '0x1', value: '1000' }, 84532);
    expect(result.signedTx).toBe('0xSIGNED');
    expect(result.txHash).toBe('0x' + 'a'.repeat(64));
  });

  it('signMessage returns signature', async () => {
    mockOwsSuccess(JSON.stringify({ ok: true, data: { signature: '0xSIG' } }));
    const w = new OWSWallet({ wallet: 'test' });
    const sig = await w.signMessage('hello');
    expect(sig).toBe('0xSIG');
  });

  it('payX402 returns response data', async () => {
    mockOwsSuccess(JSON.stringify({ ok: true, data: { message: 'paid' } }));
    const w = new OWSWallet({ wallet: 'test' });
    const result = await w.payX402('https://api.example.com');
    expect(JSON.parse(result)).toEqual({ message: 'paid' });
  });

  it('throws on policy denial', async () => {
    mockOwsError('policy denied: exceeds daily spending limit');
    const w = new OWSWallet({ wallet: 'test' });
    await expect(w.signTransaction({ to: '0x1' }, 84532)).rejects.toThrow(/OWS/);
  });

  it('throws on insufficient balance', async () => {
    mockOwsError('insufficient balance for transaction');
    const w = new OWSWallet({ wallet: 'test' });
    await expect(w.getAddress(84532)).rejects.toThrow(/balance/i);
  });

  it('walletName returns configured name', () => {
    const w = new OWSWallet({ wallet: 'my-agent' });
    expect(w.walletName).toBe('my-agent');
  });
});
