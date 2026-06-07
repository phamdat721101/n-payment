import { describe, expect, it } from 'vitest';
import { CHAINS } from '../src/chains.js';
import {
  RLUSD_NTT_DEPLOYMENTS,
  canBridgeRlusd,
  chainKeyFromWh,
  whChainFromKey,
  type WormholeChainName,
} from '../src/wormhole/deployments.js';

const ONE_RLUSD = 10n ** 18n;
const HUNDRED_RLUSD = 100n * ONE_RLUSD;

describe('RLUSD_NTT_DEPLOYMENTS — registry shape', () => {
  it('contains exactly 5 chains', () => {
    expect(Object.keys(RLUSD_NTT_DEPLOYMENTS)).toHaveLength(5);
  });

  it('all chains share the same NttManager (CREATE2 invariant)', () => {
    const managers = new Set(Object.values(RLUSD_NTT_DEPLOYMENTS).map((d) => d.manager));
    expect(managers.size).toBe(1);
    expect([...managers][0]).toBe('0x2a71afb11F4633A2681EAa19A01C47990f67E938');
  });

  it('all chains share the same Wormhole transceiver (CREATE2 invariant)', () => {
    const transceivers = new Set(Object.values(RLUSD_NTT_DEPLOYMENTS).map((d) => d.transceiver));
    expect(transceivers.size).toBe(1);
    expect([...transceivers][0]).toBe('0x7B17Afd3A51ca042cB70A8A334BC4f171fd74089');
  });

  it('Ethereum has its own RLUSD ERC-20 address (canonical issuance hub)', () => {
    expect(RLUSD_NTT_DEPLOYMENTS.Ethereum.token).toBe(
      '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD',
    );
  });

  it('all 4 L2s share the same RLUSD ERC-20 address', () => {
    const tokens = (['Base', 'Optimism', 'Ink', 'Unichain'] as WormholeChainName[]).map(
      (c) => RLUSD_NTT_DEPLOYMENTS[c].token,
    );
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe('0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258');
  });

  it('every chain has burn-and-mint mode + threshold=1', () => {
    for (const d of Object.values(RLUSD_NTT_DEPLOYMENTS)) {
      expect(d.mode).toBe('burning');
      expect(d.threshold).toBe(1);
      expect(d.paused).toBe(false);
    }
  });

  it('outbound limits are 0 across all chains (Ripple-gated supply)', () => {
    for (const d of Object.values(RLUSD_NTT_DEPLOYMENTS)) {
      expect(d.outboundLimit).toBe(0n);
    }
  });

  it('chain registry exposes RLUSD on all 5 chains via CHAINS map', () => {
    expect(CHAINS['ethereum-mainnet'].tokens.RLUSD).toBe(
      '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD',
    );
    expect(CHAINS['base-mainnet'].tokens.RLUSD).toBe(
      '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    );
    expect(CHAINS['optimism-mainnet'].tokens.RLUSD).toBe(
      '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    );
    expect(CHAINS['ink-mainnet'].tokens.RLUSD).toBe(
      '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    );
    expect(CHAINS['unichain-mainnet'].tokens.RLUSD).toBe(
      '0x8d58C0C60B8D6b88Fa98B291a646dB34d0F98258',
    );
  });
});

describe('whChainFromKey / chainKeyFromWh', () => {
  it('round-trips all 5 NTT-eligible ChainKeys', () => {
    const pairs: Array<[Parameters<typeof whChainFromKey>[0], WormholeChainName]> = [
      ['ethereum-mainnet', 'Ethereum'],
      ['base-mainnet', 'Base'],
      ['optimism-mainnet', 'Optimism'],
      ['ink-mainnet', 'Ink'],
      ['unichain-mainnet', 'Unichain'],
    ];
    for (const [key, wh] of pairs) {
      expect(whChainFromKey(key)).toBe(wh);
      expect(chainKeyFromWh(wh)).toBe(key);
    }
  });

  it('returns undefined for non-NTT ChainKeys', () => {
    expect(whChainFromKey('xrpl-mainnet')).toBeUndefined();
    expect(whChainFromKey('flare-mainnet')).toBeUndefined();
    expect(whChainFromKey('stellar-mainnet')).toBeUndefined();
  });
});

describe('canBridgeRlusd — pure-fn preflight', () => {
  it('rejects same-chain', () => {
    const r = canBridgeRlusd('Base', 'Base', ONE_RLUSD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('same-chain');
  });

  it('rejects zero / negative amounts', () => {
    expect(canBridgeRlusd('Optimism', 'Base', 0n).ok).toBe(false);
    expect(canBridgeRlusd('Optimism', 'Base', -1n).ok).toBe(false);
  });

  it('rejects when outbound is 0 (static snapshot — Ripple-gated)', () => {
    const r = canBridgeRlusd('Optimism', 'Base', ONE_RLUSD);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/outbound-limit-exceeded/);
      expect(r.suggestedFunding).toBe('native');
    }
  });

  it('accepts Optimism → Base with overridden outbound limit', () => {
    const r = canBridgeRlusd('Optimism', 'Base', ONE_RLUSD, { outbound: HUNDRED_RLUSD });
    expect(r.ok).toBe(true);
  });

  it('rejects when destination has no inbound from source (Ethereum → Optimism)', () => {
    // Even with override on outbound, Optimism's static inboundLimits is empty for Ethereum.
    const r = canBridgeRlusd('Ethereum', 'Optimism', ONE_RLUSD, { outbound: HUNDRED_RLUSD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inbound-limit-exceeded/);
  });

  it('rejects Ethereum → Base statically (Base has no Ethereum inbound peer in JSON)', () => {
    const r = canBridgeRlusd('Ethereum', 'Base', ONE_RLUSD, { outbound: HUNDRED_RLUSD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inbound-limit-exceeded/);
  });

  it('accepts Ethereum → Base with both outbound + inbound overrides (live-limits scenario)', () => {
    const r = canBridgeRlusd('Ethereum', 'Base', ONE_RLUSD, {
      outbound: HUNDRED_RLUSD,
      inbound: HUNDRED_RLUSD,
    });
    expect(r.ok).toBe(true);
  });

  it('respects live inbound override below static limit', () => {
    const r = canBridgeRlusd('Optimism', 'Base', HUNDRED_RLUSD, {
      outbound: HUNDRED_RLUSD,
      inbound: ONE_RLUSD,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/inbound-limit-exceeded/);
  });
});
