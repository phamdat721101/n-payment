import { describe, expect, it, vi } from 'vitest';
import { WormholeNttClient } from '../src/wormhole/ntt-client.js';
import { WormholeNttAdapter } from '../src/adapters/wormhole-ntt.js';
import type {
  EvmSigner,
  NttBridgeRequest,
  NttBridgeResult,
  WormholeChainName,
  WormholeNttBridge,
  WormholeNttBridgeFactory,
} from '../src/wormhole/types.js';

const ONE_RLUSD = 10n ** 18n;
const HUNDRED_RLUSD = 100n * ONE_RLUSD;

const stubSigner = (addr: `0x${string}` = '0xabcdef0123456789abcdef0123456789abcdef01'): EvmSigner => ({
  getAddress: async () => addr,
});

const stubReceipt = (overrides: Partial<NttBridgeResult> = {}): NttBridgeResult => ({
  srcTxHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  destTxHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
  vaa: 'AAAA',
  durationMs: 1234,
  ...overrides,
});

function makeStubFactory(
  receipt: NttBridgeResult = stubReceipt(),
): { factory: WormholeNttBridgeFactory; transferSpy: ReturnType<typeof vi.fn> } {
  const transferSpy = vi.fn(async (_req: NttBridgeRequest) => receipt);
  const bridge: WormholeNttBridge = { transferAndRedeem: transferSpy };
  const factory: WormholeNttBridgeFactory = { create: async () => bridge };
  return { factory, transferSpy };
}

describe('WormholeNttClient — preflight', () => {
  it('rejects same-chain', () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const r = client.preflight({ from: 'Optimism', to: 'Optimism', amount: ONE_RLUSD, recipient: '0xab' as `0x${string}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('same-chain');
  });

  it('rejects when no signer for source chain', () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: {}, bridgeFactory: factory });
    const r = client.preflight({ from: 'Optimism', to: 'Base', amount: ONE_RLUSD, recipient: '0xab' as `0x${string}` });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no-signer-for-Optimism/);
  });

  it('rejects when static outbound limit is 0', () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const r = client.preflight({ from: 'Optimism', to: 'Base', amount: ONE_RLUSD, recipient: '0xab' as `0x${string}` });
    // Outbound = 0 statically (Ripple-gated); preflight fails until live limits override.
    expect(r.ok).toBe(false);
  });
});

describe('WormholeNttClient — transfer', () => {
  it('dry-run returns dry-run receipt without invoking factory', async () => {
    const { factory, transferSpy } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const receipt = await client.transfer({
      from: 'Optimism', to: 'Base', amount: ONE_RLUSD, recipient: '0xab' as `0x${string}`, dryRun: true,
    });
    expect(receipt.whTxId).toBe('dry-run');
    expect(transferSpy).not.toHaveBeenCalled();
  });

  it('throws WORMHOLE_NTT_PREFLIGHT_FAILED on outbound 0', async () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    await expect(
      client.transfer({ from: 'Optimism', to: 'Base', amount: ONE_RLUSD, recipient: '0xab' as `0x${string}` }),
    ).rejects.toMatchObject({ code: 'WORMHOLE_NTT_PREFLIGHT_FAILED' });
  });
});

describe('WormholeNttAdapter — caps', () => {
  it('detect always returns false (not a top-level adapter)', () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const adapter = new WormholeNttAdapter(client);
    expect(adapter.detect(new Response())).toBe(false);
  });

  it('pay throws WORMHOLE_NTT_USE_PAYROUTER', async () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const adapter = new WormholeNttAdapter(client);
    await expect(adapter.pay('https://x', undefined, new Response())).rejects.toMatchObject({
      code: 'WORMHOLE_NTT_USE_PAYROUTER',
    });
  });

  it('rejects unsupported chain key', async () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const adapter = new WormholeNttAdapter(client);
    await expect(
      adapter.bridgeRlusd({
        fromChain: 'creditcoin-mainnet',
        toChain: 'base-mainnet',
        amount: ONE_RLUSD,
        recipient: '0xab' as `0x${string}`,
      }),
    ).rejects.toMatchObject({ code: 'WORMHOLE_NTT_CHAIN_UNSUPPORTED' });
  });

  it('throws on max-per-transfer breach', async () => {
    const { factory } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    const adapter = new WormholeNttAdapter(client, { maxPerTransfer: ONE_RLUSD });
    await expect(
      adapter.bridgeRlusd({
        fromChain: 'optimism-mainnet',
        toChain: 'base-mainnet',
        amount: HUNDRED_RLUSD,
        recipient: '0xab' as `0x${string}`,
      }),
    ).rejects.toMatchObject({ code: 'WORMHOLE_NTT_MAX_PER_TRANSFER' });
  });
});

describe('WormholeNttAdapter — happy path with mocked bridge', () => {
  it('forwards to client.transfer when within caps and live-limit override is supplied', async () => {
    // Override the static outbound-0 by injecting a custom bridge factory that bypasses preflight
    // (the factory itself is unaware of static limits — it's the client's preflight that gates).
    // For this test we monkey-patch the client.preflight to always pass, simulating live-limit override.
    const { factory, transferSpy } = makeStubFactory();
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() }, bridgeFactory: factory });
    // Live-limit shim: force preflight ok=true (production code will read on-chain limits in v0.23).
    (client as unknown as { preflight: () => { ok: true } }).preflight = () => ({ ok: true });

    const adapter = new WormholeNttAdapter(client, {
      maxPerTransfer: HUNDRED_RLUSD,
      maxPerDay: HUNDRED_RLUSD * 10n,
    });
    const receipt = await adapter.bridgeRlusd({
      fromChain: 'optimism-mainnet',
      toChain: 'base-mainnet',
      amount: ONE_RLUSD,
      recipient: '0xab' as `0x${string}`,
    });
    expect(transferSpy).toHaveBeenCalledOnce();
    expect(transferSpy).toHaveBeenCalledWith({ amount: ONE_RLUSD, recipient: '0xab' });
    expect(receipt.status).toBe('redeemed');
    expect(receipt.destTxHash).toBeDefined();
  });
});

describe('createDefaultWormholeNttBridgeFactory — peer-dep error', () => {
  it('throws WORMHOLE_NTT_PEER_DEP_MISSING when @wormhole-foundation/sdk is not installed', async () => {
    // The peer dep is not installed in this repo (intentionally — soft-disable model).
    // Constructing the client with no bridgeFactory uses the default; create() will throw
    // when first invoked.
    const client = new WormholeNttClient({ signers: { Optimism: stubSigner() } });
    // Use any source/dest chain — the peer-dep check fires first.
    const factory = (client as unknown as { factory: WormholeNttBridgeFactory }).factory;
    await expect(factory.create('Optimism' as WormholeChainName, 'Base' as WormholeChainName)).rejects.toMatchObject(
      { code: 'WORMHOLE_NTT_PEER_DEP_MISSING' },
    );
  });
});
