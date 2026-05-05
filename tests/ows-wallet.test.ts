import { describe, it, expect } from 'vitest';
import { OWSWallet } from '../src/ows/wallet.js';

// Valid test private key (never use in production)
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('OWSWallet', () => {
  it('getAddress returns a valid address', () => {
    const w = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const addr = w.getAddress(84532);
    expect(addr).toMatch(/^0x[a-fA-F0-9]{40}$/);
  });

  it('getAddress returns same address for any chainId', () => {
    const w = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    expect(w.getAddress(84532)).toBe(w.getAddress(8453));
  });

  it('signMessage returns a valid signature', async () => {
    const w = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    const sig = await w.signMessage('hello');
    expect(sig).toMatch(/^0x[a-fA-F0-9]+$/);
  });

  it('payX402 throws NOT_IMPLEMENTED', async () => {
    const w = new OWSWallet({ wallet: 'test', privateKey: TEST_KEY });
    await expect(w.payX402('https://example.com')).rejects.toThrow('direct adapter usage');
  });

  it('walletName returns configured name', () => {
    const w = new OWSWallet({ wallet: 'my-agent', privateKey: TEST_KEY });
    expect(w.walletName).toBe('my-agent');
  });

  it('throws on invalid private key', () => {
    expect(() => {
      const w = new OWSWallet({ wallet: 'test', privateKey: 'invalid' });
      w.getAddress(84532);
    }).toThrow();
  });
});
