/**
 * v0.25 — Celo Agent Visa tracker unit tests.
 *
 * Covers tier math (none/tourist/work/citizenship boundaries), recordPayment
 * accumulation, persistence roundtrip for both storage backends, and
 * concurrent-write safety via the per-key mutex.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CeloAgentVisaTracker,
  computeAgentVisaTier,
  MemoryAgentVisaStorage,
  JsonFileAgentVisaStorage,
} from '../src/celo/agent-visa.js';

const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
const BOB   = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const;

describe('computeAgentVisaTier', () => {
  it('returns none for zero tx', () => {
    expect(computeAgentVisaTier({ txCount: 0, volumeUsd: 0, selfAgentIdProvided: true })).toBe('none');
  });

  it('returns tourist for first tx without Self ID', () => {
    expect(computeAgentVisaTier({ txCount: 1, volumeUsd: 0.01, selfAgentIdProvided: false })).toBe('tourist');
  });

  it('stays tourist if Self ID missing even with 5K volume', () => {
    expect(computeAgentVisaTier({ txCount: 1_500, volumeUsd: 7_000, selfAgentIdProvided: false })).toBe('tourist');
  });

  it('upgrades to work at 1000 tx with Self ID', () => {
    expect(computeAgentVisaTier({ txCount: 1_000, volumeUsd: 0, selfAgentIdProvided: true })).toBe('work');
  });

  it('upgrades to work at $5K volume with Self ID', () => {
    expect(computeAgentVisaTier({ txCount: 1, volumeUsd: 5_000, selfAgentIdProvided: true })).toBe('work');
  });

  it('upgrades to citizenship at 10000 tx (Self ID irrelevant at this tier)', () => {
    expect(computeAgentVisaTier({ txCount: 10_000, volumeUsd: 0, selfAgentIdProvided: false })).toBe('citizenship');
  });

  it('upgrades to citizenship at $15K volume', () => {
    expect(computeAgentVisaTier({ txCount: 1, volumeUsd: 15_000, selfAgentIdProvided: false })).toBe('citizenship');
  });
});

describe('CeloAgentVisaTracker — recordPayment', () => {
  let storage: MemoryAgentVisaStorage;
  let tracker: CeloAgentVisaTracker;

  beforeEach(() => {
    storage = new MemoryAgentVisaStorage();
    tracker = new CeloAgentVisaTracker(storage, { selfAgentIdProvided: true });
  });

  it('first record creates state with tier=tourist', async () => {
    const s = await tracker.recordPayment(ALICE, 1, 'sepolia');
    expect(s.txCount).toBe(1);
    expect(s.volumeUsd).toBe(1);
    expect(s.tier).toBe('tourist');
    expect(s.firstTxAt).toBeGreaterThan(0);
  });

  it('accumulates txCount and volume across calls', async () => {
    await tracker.recordPayment(ALICE, 10, 'mainnet');
    await tracker.recordPayment(ALICE, 20, 'mainnet');
    await tracker.recordPayment(ALICE, 30, 'mainnet');
    const s = await tracker.getStatus(ALICE);
    expect(s.txCount).toBe(3);
    expect(s.volumeUsd).toBe(60);
  });

  it('promotes to work after $5K cumulative volume', async () => {
    await tracker.recordPayment(ALICE, 4_000, 'mainnet');
    let s = await tracker.getStatus(ALICE);
    expect(s.tier).toBe('tourist');
    await tracker.recordPayment(ALICE, 1_500, 'mainnet');
    s = await tracker.getStatus(ALICE);
    expect(s.tier).toBe('work');
  });

  it('treats negative amount as zero (defensive — never reduces volume)', async () => {
    await tracker.recordPayment(ALICE, -50, 'mainnet');
    const s = await tracker.getStatus(ALICE);
    expect(s.volumeUsd).toBe(0);
  });

  it('getStatus returns default none-tier state for unknown addr', async () => {
    const s = await tracker.getStatus(BOB);
    expect(s.tier).toBe('none');
    expect(s.txCount).toBe(0);
  });

  it('serializes concurrent recordPayment calls (no lost updates)', async () => {
    await Promise.all(Array.from({ length: 50 }, () => tracker.recordPayment(ALICE, 1, 'mainnet')));
    const s = await tracker.getStatus(ALICE);
    expect(s.txCount).toBe(50);
    expect(s.volumeUsd).toBe(50);
  });
});

describe('JsonFileAgentVisaStorage', () => {
  let tmpFile: string;
  let storage: JsonFileAgentVisaStorage;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'celo-visa-'));
    tmpFile = join(dir, 'visa.json');
    storage = new JsonFileAgentVisaStorage(tmpFile);
  });

  it('returns null when file does not exist (ENOENT handled)', async () => {
    const s = await storage.read(ALICE);
    expect(s).toBeNull();
  });

  it('write + read roundtrip persists state', async () => {
    const tracker = new CeloAgentVisaTracker(storage, { selfAgentIdProvided: true });
    const written = await tracker.recordPayment(ALICE, 100, 'mainnet');
    const read = await storage.read(ALICE);
    expect(read).not.toBeNull();
    expect(read?.txCount).toBe(written.txCount);
    expect(read?.volumeUsd).toBe(100);
    expect(read?.tier).toBe('tourist');
  });

  it('multiple agents persist independently', async () => {
    const tracker = new CeloAgentVisaTracker(storage, { selfAgentIdProvided: true });
    await tracker.recordPayment(ALICE, 10, 'mainnet');
    await tracker.recordPayment(BOB, 20, 'mainnet');
    const aliceState = await storage.read(ALICE);
    const bobState = await storage.read(BOB);
    expect(aliceState?.volumeUsd).toBe(10);
    expect(bobState?.volumeUsd).toBe(20);
  });

  it('stores keys lowercase to be address-case-insensitive', async () => {
    const tracker = new CeloAgentVisaTracker(storage, { selfAgentIdProvided: true });
    await tracker.recordPayment(ALICE, 5, 'mainnet');
    // Read with uppercase variant
    const upper = (ALICE.toUpperCase().replace('0X', '0x')) as `0x${string}`;
    const s = await storage.read(upper);
    expect(s?.volumeUsd).toBe(5);
  });
});
