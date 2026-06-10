/**
 * v0.25 — Celo Agent Visa tracker.
 *
 * Tracks every n-payment Celo settlement against the agent's tier (Tourist /
 * Work / Citizenship) per the criteria from self.xyz/blog/agent-visa:
 *
 *   • Tourist     — 1+ tx
 *   • Work        — 1 000+ tx OR $5K+ volume, AND verified Self Agent ID
 *   • Citizenship — 10 000+ tx OR $15K+ volume
 *
 * Storage is pluggable (`AgentVisaStorage` interface in src/types.ts) — the
 * tracker owns the math, integrators own persistence (memory, JSON file,
 * Redis, DynamoDB, …). v0.25 ships memory + JSON-file backends.
 *
 * SOLID — Single Responsibility: tier math + accumulation. Storage is a
 * dependency-injected interface; nothing else in this file touches I/O
 * outside of the storage contract.
 */
import type { Address } from 'viem';
import { promises as fs } from 'node:fs';
import type {
  AgentVisaState,
  AgentVisaStorage,
  CeloAgentVisaTier,
} from '../types.js';

export interface CeloAgentVisaTrackerOptions {
  /** Whether the agent has a verified Self.xyz Agent ID — Work-tier requirement. */
  selfAgentIdProvided?: boolean;
}

/** Pure tier math — no I/O, deterministic, easy to test. */
export function computeAgentVisaTier(state: {
  txCount: number;
  volumeUsd: number;
  selfAgentIdProvided: boolean;
}): CeloAgentVisaTier {
  if (state.txCount === 0) return 'none';
  if (state.txCount >= 10_000 || state.volumeUsd >= 15_000) return 'citizenship';
  if (state.selfAgentIdProvided && (state.txCount >= 1_000 || state.volumeUsd >= 5_000)) {
    return 'work';
  }
  return 'tourist';
}

export class CeloAgentVisaTracker {
  private readonly mutex = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: AgentVisaStorage,
    private readonly opts: CeloAgentVisaTrackerOptions = {},
  ) {}

  /**
   * Record a successful Celo payment. Returns the updated state.
   * Concurrent calls for the same agent are serialised via per-key mutex
   * to prevent lost updates.
   */
  async recordPayment(
    agentAddress: Address,
    amountUsd: number,
    network: 'mainnet' | 'sepolia',
  ): Promise<AgentVisaState> {
    return this.withLock(agentAddress, async () => {
      const prior = await this.storage.read(agentAddress);
      const now = Date.now();
      const next: AgentVisaState = {
        agentAddress,
        txCount: (prior?.txCount ?? 0) + 1,
        volumeUsd: (prior?.volumeUsd ?? 0) + Math.max(0, amountUsd),
        selfAgentIdProvided: this.opts.selfAgentIdProvided ?? prior?.selfAgentIdProvided ?? false,
        tier: 'none',
        firstTxAt: prior?.firstTxAt ?? now,
        lastTxAt: now,
        network,
      };
      next.tier = computeAgentVisaTier(next);
      await this.storage.write(next);
      return next;
    });
  }

  /** Read current state. Returns a default `none`-tier state when unknown. */
  async getStatus(agentAddress: Address, network: 'mainnet' | 'sepolia' = 'mainnet'): Promise<AgentVisaState> {
    const s = await this.storage.read(agentAddress);
    if (s) return s;
    return {
      agentAddress, txCount: 0, volumeUsd: 0,
      selfAgentIdProvided: this.opts.selfAgentIdProvided ?? false,
      tier: 'none', firstTxAt: 0, lastTxAt: 0, network,
    };
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    this.mutex.set(key, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // Cleanup map entry if no further work queued.
      if (this.mutex.get(key) === prev.then(() => next)) this.mutex.delete(key);
    }
  }
}

// ─── Storage backends ──────────────────────────────────────────────────────

/** In-memory storage. Single-process; lost on restart. Default for dev. */
export class MemoryAgentVisaStorage implements AgentVisaStorage {
  private readonly store = new Map<string, AgentVisaState>();
  async read(agentAddress: Address): Promise<AgentVisaState | null> {
    return this.store.get(agentAddress.toLowerCase()) ?? null;
  }
  async write(state: AgentVisaState): Promise<void> {
    this.store.set(state.agentAddress.toLowerCase(), state);
  }
}

/**
 * JSON-file-backed storage. Single-process semantics — concurrent writes
 * across processes are NOT safe; use a real KV (Redis / DynamoDB) in prod.
 *
 * File format: `{ "<addr-lower>": { ...AgentVisaState }, ... }`. Unknown
 * fields are preserved on read; missing fields default sensibly. The file
 * is created on first write.
 */
export class JsonFileAgentVisaStorage implements AgentVisaStorage {
  private readonly mutex = Promise.resolve(); // future-proof reserved
  constructor(private readonly path: string) {}

  async read(agentAddress: Address): Promise<AgentVisaState | null> {
    const all = await this.readAll();
    return all[agentAddress.toLowerCase()] ?? null;
  }

  async write(state: AgentVisaState): Promise<void> {
    const all = await this.readAll();
    all[state.agentAddress.toLowerCase()] = state;
    await fs.writeFile(this.path, JSON.stringify(all, replacer, 2), 'utf8');
  }

  private async readAll(): Promise<Record<string, AgentVisaState>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    return JSON.parse(raw) as Record<string, AgentVisaState>;
  }
}

// JSON.stringify replacer to preserve numeric fields. AgentVisaState carries
// no bigints today; this is a no-op placeholder for forward compatibility.
function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}
