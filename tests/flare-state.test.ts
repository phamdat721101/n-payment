import { describe, it, expect, vi } from 'vitest';
import { NPaymentError } from '../src/errors.js';
import { FlareClient } from '../src/flare/client.js';
import {
  getPersonalAccountAddress,
  isSmartAccount,
  getOperatorXrplAddresses,
  getFxrpAddress,
  getFxrpBalance,
  getFxrpDecimals,
  getVaults,
  getAgentVaults,
} from '../src/flare/state.js';

const ASSET_MANAGER = '0x1111111111111111111111111111111111111111';
const MASTER_AC = '0x2222222222222222222222222222222222222222';
const FXRP = '0x3333333333333333333333333333333333333333';
const PERSONAL_ACCOUNT = '0x4444444444444444444444444444444444444444';

/** Build a FlareClient with a stubbed publicClient that routes by (address, functionName). */
function makeFlareClient(routes: Record<string, unknown | (() => unknown)>): FlareClient {
  const readContract = vi.fn(async (req: { address: string; functionName: string; args?: unknown[] }) => {
    const key = `${req.address.toLowerCase()}::${req.functionName}`;
    const handler = routes[key];
    if (handler === undefined) {
      throw new Error(`unmocked readContract: ${key}`);
    }
    return typeof handler === 'function' ? (handler as () => unknown)() : handler;
  });

  const client = new FlareClient({ publicClient: { readContract } as never });
  // Pre-seed registry cache so we never hit the unmocked registry call.
  (client.registry as unknown as { cache: Map<string, { address: string; expiresAt: number }> })
    .cache.set('AssetManagerFXRP', { address: ASSET_MANAGER, expiresAt: Date.now() + 1e9 });
  (client.registry as unknown as { cache: Map<string, { address: string; expiresAt: number }> })
    .cache.set('MasterAccountController', { address: MASTER_AC, expiresAt: Date.now() + 1e9 });
  return client;
}

describe('getPersonalAccountAddress', () => {
  it('resolves the PersonalAccount for a given XRPL address', async () => {
    const client = makeFlareClient({
      [`${MASTER_AC.toLowerCase()}::getPersonalAccount`]: PERSONAL_ACCOUNT,
    });
    expect(await getPersonalAccountAddress(client, 'rPdLcCkSJzLvURM2vV3bCWwXBgT7FyJojU'))
      .toBe(PERSONAL_ACCOUNT);
  });

  it('throws FLARE_PERSONAL_ACCOUNT_RESOLUTION_FAILED on zero-address response', async () => {
    const client = makeFlareClient({
      [`${MASTER_AC.toLowerCase()}::getPersonalAccount`]: '0x0000000000000000000000000000000000000000',
    });
    await expect(
      getPersonalAccountAddress(client, 'rPdLcCkSJzLvURM2vV3bCWwXBgT7FyJojU'),
    ).rejects.toMatchObject({ code: 'FLARE_PERSONAL_ACCOUNT_RESOLUTION_FAILED' });
  });
});

describe('isSmartAccount', () => {
  it('returns true when xrplOwner() returns a non-empty string', async () => {
    const client = makeFlareClient({
      [`${PERSONAL_ACCOUNT.toLowerCase()}::xrplOwner`]: 'rPdLcCkSJzLvURM2vV3bCWwXBgT7FyJojU',
    });
    expect(await isSmartAccount(client, PERSONAL_ACCOUNT)).toBe(true);
  });

  it('returns false on read errors (account not deployed yet)', async () => {
    const client = makeFlareClient({
      [`${PERSONAL_ACCOUNT.toLowerCase()}::xrplOwner`]: () => {
        throw new Error('reverted');
      },
    });
    expect(await isSmartAccount(client, PERSONAL_ACCOUNT)).toBe(false);
  });
});

describe('getOperatorXrplAddresses', () => {
  it('returns the registered operator XRPL wallets', async () => {
    const client = makeFlareClient({
      [`${MASTER_AC.toLowerCase()}::getXrplProviderWallets`]: [
        'rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq',
      ],
    });
    expect(await getOperatorXrplAddresses(client)).toHaveLength(1);
  });
});

describe('FXRP token reads', () => {
  it('getFxrpAddress reads via AssetManagerFXRP.fAsset()', async () => {
    const client = makeFlareClient({
      [`${ASSET_MANAGER.toLowerCase()}::fAsset`]: FXRP,
    });
    expect(await getFxrpAddress(client)).toBe(FXRP);
  });

  it('getFxrpBalance + getFxrpDecimals chain through getFxrpAddress', async () => {
    const client = makeFlareClient({
      [`${ASSET_MANAGER.toLowerCase()}::fAsset`]: FXRP,
      [`${FXRP.toLowerCase()}::balanceOf`]: 1_000_000n,
      [`${FXRP.toLowerCase()}::decimals`]: 6,
    });
    expect(await getFxrpBalance(client, PERSONAL_ACCOUNT)).toBe(1_000_000n);
    expect(await getFxrpDecimals(client)).toBe(6);
  });
});

describe('vault listings', () => {
  it('getVaults zips the (ids, addresses, types) tuple into typed records', async () => {
    const client = makeFlareClient({
      [`${MASTER_AC.toLowerCase()}::getVaults`]: [
        [2n, 1n],
        ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
        [2, 1],
      ],
    });
    const vaults = await getVaults(client);
    expect(vaults).toEqual([
      { id: 2n, address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', type: 2 },
      { id: 1n, address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', type: 1 },
    ]);
  });

  it('getAgentVaults zips the (ids, addresses) tuple', async () => {
    const client = makeFlareClient({
      [`${MASTER_AC.toLowerCase()}::getAgentVaults`]: [
        [1n],
        ['0xcccccccccccccccccccccccccccccccccccccccc'],
      ],
    });
    expect(await getAgentVaults(client)).toEqual([
      { id: 1n, address: '0xcccccccccccccccccccccccccccccccccccccccc' },
    ]);
  });

  it('returns [] for empty vault registries', async () => {
    const client = makeFlareClient({
      [`${MASTER_AC.toLowerCase()}::getVaults`]: [[], [], []],
      [`${MASTER_AC.toLowerCase()}::getAgentVaults`]: [[], []],
    });
    expect(await getVaults(client)).toEqual([]);
    expect(await getAgentVaults(client)).toEqual([]);
  });
});

// Type guard so tsc accepts NPaymentError import even if no test references it directly.
void NPaymentError;
