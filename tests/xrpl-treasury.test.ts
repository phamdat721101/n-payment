import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NPaymentError } from '../src/errors.js';
import {
  XrplTreasuryManager,
  MemoryVaultIdStore,
  type VaultIdStore,
} from '../src/xrpl/treasury.js';
import { RLUSD_ISSUERS } from '../src/xrpl/utils.js';
import { clearAccountStateCache } from '../src/xrpl/payments.js';

const TEST_ADDR = 'rTreasury00000000000000000000000';

function makeClient(overrides: { lines?: unknown[]; xrpDrops?: bigint } = {}) {
  const drops = overrides.xrpDrops ?? 10_000_000n; // 10 XRP default
  const lines = overrides.lines ?? [];
  return {
    request: vi.fn(async (req: { command: string }) => {
      if (req.command === 'account_info') {
        return { result: { account_data: { Balance: drops.toString(), Sequence: 1 } } };
      }
      if (req.command === 'account_lines') {
        return { result: { lines } };
      }
      return { result: {} };
    }),
    autofill: vi.fn(async (tx) => tx),
    submitAndWait: vi.fn(async () => ({ result: { hash: '0xVT', meta: {} } })),
    isConnected: () => true,
  };
}

function makeConnection(client: ReturnType<typeof makeClient>) {
  return { getClient: vi.fn(async () => client) } as unknown as import('../src/xrpl/connection.js').XrplConnection;
}

function makeWallet(addr = TEST_ADDR) {
  return {
    getAddress: vi.fn(async () => addr),
    sign: vi.fn(async () => ({ tx_blob: 'BLOB', hash: '0xVT' })),
  } as unknown as import('../src/xrpl/wallet.js').XrplWallet;
}

function makeVault() {
  return {
    createVault: vi.fn(async () => ({ hash: '0xCREATE', vaultId: 'VAULT_NEW' })),
    deposit: vi.fn(async () => ({ hash: '0xDEP', sharesReceived: '1' })),
    withdraw: vi.fn(async () => ({ hash: '0xWIT', assetsReceived: '1' })),
    getVaultInfo: vi.fn(async () => ({
      vaultId: 'VAULT_NEW',
      owner: TEST_ADDR,
      asset: { currency: 'RLUSD', issuer: RLUSD_ISSUERS.testnet },
      totalAssets: '50',
      totalShares: '50000000',
      lossUnrealized: '0',
      sharesMPTId: 'MPT',
    })),
  } as unknown as import('../src/xrpl/vault.js').XrplVaultClient;
}

beforeEach(() => {
  clearAccountStateCache();
  vi.clearAllMocks();
});

// ─── ensureVault ─────────────────────────────────────────────────────────────

describe('XrplTreasuryManager.ensureVault', () => {
  it('returns explicit vaultId without creating', async () => {
    const vault = makeVault();
    const tm = new XrplTreasuryManager(
      { vaultId: 'EXISTING', autoCreate: true },
      { connection: makeConnection(makeClient()), wallet: makeWallet(), vault, network: 'testnet' },
    );
    expect(await tm.ensureVault()).toBe('EXISTING');
    expect(vault.createVault).not.toHaveBeenCalled();
  });

  it('returns store-persisted vaultId on subsequent boots', async () => {
    const vault = makeVault();
    const store: VaultIdStore = new MemoryVaultIdStore();
    await store.write(TEST_ADDR, 'PERSISTED');
    const tm = new XrplTreasuryManager(
      { autoCreate: true, store },
      { connection: makeConnection(makeClient()), wallet: makeWallet(), vault, network: 'testnet' },
    );
    expect(await tm.ensureVault()).toBe('PERSISTED');
    expect(vault.createVault).not.toHaveBeenCalled();
  });

  it('auto-creates exactly once and persists to store', async () => {
    const vault = makeVault();
    const store: VaultIdStore = new MemoryVaultIdStore();
    const tm = new XrplTreasuryManager(
      { autoCreate: true, store },
      { connection: makeConnection(makeClient()), wallet: makeWallet(), vault, network: 'testnet' },
    );
    expect(await tm.ensureVault()).toBe('VAULT_NEW');
    expect(await tm.ensureVault()).toBe('VAULT_NEW'); // cached, not re-created
    expect(vault.createVault).toHaveBeenCalledOnce();
    expect(await store.read(TEST_ADDR)).toBe('VAULT_NEW');
  });

  it('throws XRPL_NO_VAULT when neither vaultId nor autoCreate', async () => {
    const tm = new XrplTreasuryManager(
      {},
      { connection: makeConnection(makeClient()), wallet: makeWallet(), vault: makeVault(), network: 'testnet' },
    );
    await expect(tm.ensureVault()).rejects.toMatchObject({ code: 'XRPL_NO_VAULT' });
  });

  it('throws XRPL_INSUFFICIENT_XRP_RESERVE before VaultCreate when wallet is dry', async () => {
    const vault = makeVault();
    const tm = new XrplTreasuryManager(
      { autoCreate: true, minXrpReserve: 5_000_000n },
      {
        connection: makeConnection(makeClient({ xrpDrops: 1_000_000n })),
        wallet: makeWallet(), vault, network: 'testnet',
      },
    );
    const err = await tm.ensureVault().catch((e) => e);
    expect(err).toBeInstanceOf(NPaymentError);
    expect((err as NPaymentError).code).toBe('XRPL_INSUFFICIENT_XRP_RESERVE');
    expect(vault.createVault).not.toHaveBeenCalled();
  });
});

// ─── ensureLiquid ────────────────────────────────────────────────────────────

describe('XrplTreasuryManager.ensureLiquid', () => {
  it('no-op when liquid balance ≥ amount', async () => {
    const vault = makeVault();
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '100' }];
    const tm = new XrplTreasuryManager(
      { vaultId: 'V1' },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    await tm.ensureLiquid('50');
    expect(vault.withdraw).not.toHaveBeenCalled();
  });

  it('withdraws the exact shortfall', async () => {
    const vault = makeVault();
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '5' }];
    const tm = new XrplTreasuryManager(
      { vaultId: 'V1' },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    await tm.ensureLiquid('10');
    expect(vault.withdraw).toHaveBeenCalledWith('V1', { amount: '5' });
  });
});

// ─── sweep / scheduleSweep ───────────────────────────────────────────────────

describe('XrplTreasuryManager sweep', () => {
  it('sweepExcess deposits only above minIdleBalance', async () => {
    const vault = makeVault();
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '25' }];
    const tm = new XrplTreasuryManager(
      { autoYield: true, vaultId: 'V1', minIdleBalance: '10' },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    await tm.sweepExcess();
    expect(vault.deposit).toHaveBeenCalledWith('V1', '15');
  });

  it('sweepExcess no-op when liquid ≤ minIdleBalance', async () => {
    const vault = makeVault();
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '5' }];
    const tm = new XrplTreasuryManager(
      { autoYield: true, vaultId: 'V1', minIdleBalance: '10' },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    await tm.sweepExcess();
    expect(vault.deposit).not.toHaveBeenCalled();
  });

  it('scheduleSweep coalesces — multiple calls produce one sweep', async () => {
    vi.useFakeTimers();
    const vault = makeVault();
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '50' }];
    const tm = new XrplTreasuryManager(
      { autoYield: true, vaultId: 'V1', minIdleBalance: '10', sweepDebounceMs: 1000 },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    tm.scheduleSweep(); tm.scheduleSweep(); tm.scheduleSweep();
    await vi.advanceTimersByTimeAsync(1100);
    expect(vault.deposit).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('sweep failures are best-effort (do not throw upstream)', async () => {
    vi.useFakeTimers();
    const vault = makeVault();
    (vault.deposit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '50' }];
    const tm = new XrplTreasuryManager(
      { autoYield: true, vaultId: 'V1', minIdleBalance: '10', sweepDebounceMs: 100 },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    tm.scheduleSweep();
    // Must not throw even though deposit rejects.
    await expect(vi.advanceTimersByTimeAsync(200)).resolves.not.toThrow();
    vi.useRealTimers();
  });
});

// ─── isEnabled / getState ────────────────────────────────────────────────────

describe('XrplTreasuryManager state', () => {
  it('isEnabled mirrors AaveTreasuryManager.yield.isEnabled() shape', () => {
    const deps = {
      connection: makeConnection(makeClient()), wallet: makeWallet(), vault: makeVault(), network: 'testnet' as const,
    };
    expect(new XrplTreasuryManager({ autoYield: true }, deps).isEnabled()).toBe(true);
    expect(new XrplTreasuryManager({}, deps).isEnabled()).toBe(false);
  });

  it('getState returns liquid + supplied + vaultId + address', async () => {
    const vault = makeVault();
    const lines = [{ currency: 'RLUSD', account: RLUSD_ISSUERS.testnet, balance: '12' }];
    const tm = new XrplTreasuryManager(
      { vaultId: 'V1' },
      { connection: makeConnection(makeClient({ lines })), wallet: makeWallet(), vault, network: 'testnet' },
    );
    const state = await tm.getState();
    expect(state.liquid).toBe('12');
    expect(state.vaultId).toBe('V1');
    expect(state.address).toBe(TEST_ADDR);
    expect(state.supplied).toBe('50');
  });
});
