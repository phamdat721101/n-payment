import { describe, it, expect, vi } from 'vitest';
import { NPaymentError } from '../src/errors.js';
import { getChain } from '../src/chains.js';
import {
  FlareClient,
  FlareContractsRegistry,
  FLARE_CONTRACT_REGISTRY_ADDRESS,
  createFlareClient,
} from '../src/flare/client.js';

describe('Flare chain registry entry', () => {
  it('flare-coston2-testnet is registered with chainId 114 and Coston2 RPC', () => {
    const chain = getChain('flare-coston2-testnet');
    expect(chain.chainId).toBe(114);
    expect(chain.rpcUrl).toMatch(/coston2-api\.flare\.network/);
    expect(chain.protocols).toContain('flare-fxrp');
  });
});

describe('FLARE_CONTRACT_REGISTRY_ADDRESS', () => {
  it('is the canonical well-known root (must never silently change)', () => {
    expect(FLARE_CONTRACT_REGISTRY_ADDRESS).toBe(
      '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019',
    );
  });
});

describe('FlareClient', () => {
  it('defaults to Coston2 testnet and exposes a registry', () => {
    const client = createFlareClient();
    expect(client.network).toBe('coston2-testnet');
    expect(client.registry).toBeInstanceOf(FlareContractsRegistry);
  });

  it('rejects unsupported networks (mainnet deferred to v0.16)', () => {
    expect(() =>
      // @ts-expect-error — covering runtime guard
      new FlareClient({ network: 'mainnet' }),
    ).toThrow(NPaymentError);
  });

  it('respects an injected PublicClient', () => {
    const fakePublic = { readContract: vi.fn() } as never;
    const client = new FlareClient({ publicClient: fakePublic });
    expect(client.publicClient).toBe(fakePublic);
  });
});

describe('FlareContractsRegistry', () => {
  function makeRegistry(reads: Array<string | Error>) {
    let i = 0;
    const publicClient = {
      readContract: vi.fn(async () => {
        const r = reads[i++];
        if (r instanceof Error) throw r;
        return r;
      }),
    } as never;
    return { publicClient, registry: new FlareContractsRegistry(publicClient) };
  }

  it('resolves and caches addresses (second call is read-free)', async () => {
    const addr = '0x1111111111111111111111111111111111111111';
    const { publicClient, registry } = makeRegistry([addr, addr]);
    expect(await registry.address('AssetManagerFXRP')).toBe(addr);
    expect(await registry.address('AssetManagerFXRP')).toBe(addr);
    expect((publicClient as any).readContract).toHaveBeenCalledTimes(1);
  });

  it('throws FLARE_CONTRACT_NOT_FOUND on zero-address response', async () => {
    const { registry } = makeRegistry([
      '0x0000000000000000000000000000000000000000',
    ]);
    await expect(registry.address('AssetManagerFXRP')).rejects.toMatchObject({
      code: 'FLARE_CONTRACT_NOT_FOUND',
    });
  });

  it('clearCache forces a refetch', async () => {
    const a = '0x1111111111111111111111111111111111111111';
    const b = '0x2222222222222222222222222222222222222222';
    const { publicClient, registry } = makeRegistry([a, b]);
    expect(await registry.address('MasterAccountController')).toBe(a);
    registry.clearCache();
    expect(await registry.address('MasterAccountController')).toBe(b);
    expect((publicClient as any).readContract).toHaveBeenCalledTimes(2);
  });
});
