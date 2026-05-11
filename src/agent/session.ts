import type { Session, SessionConfig } from './types.js';
import type { ChainKey } from '../types.js';

export class SessionManager {
  private sessions = new Map<string, Session>();
  private config: Required<SessionConfig>;

  constructor(config: SessionConfig) {
    this.config = {
      defaultBudget: config.defaultBudget,
      ttlMs: config.ttlMs ?? 300_000,
      settleThreshold: config.settleThreshold ?? 80,
    };
  }

  create(caller: string, provider: string, chain: ChainKey, budget?: number): Session {
    const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const session: Session = {
      id,
      callerAddress: caller,
      providerAddress: provider,
      budget: budget ?? this.config.defaultBudget,
      spent: 0,
      chain,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.ttlMs,
      status: 'active',
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (s && s.status === 'active' && Date.now() > s.expiresAt) {
      s.status = 'expired';
    }
    return s;
  }

  /** Charge against session budget. Returns false if insufficient. */
  charge(id: string, amount: number): boolean {
    const s = this.get(id);
    if (!s || s.status !== 'active') return false;
    if (s.spent + amount > s.budget) return false;
    s.spent += amount;
    return true;
  }

  /** Check if session should auto-settle (spent >= threshold %) */
  shouldSettle(id: string): boolean {
    const s = this.get(id);
    if (!s) return false;
    return (s.spent / s.budget) * 100 >= this.config.settleThreshold;
  }

  settle(id: string): Session | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    s.status = 'settled';
    return s;
  }

  /** Get all active sessions for a caller */
  getActiveSessions(caller: string): Session[] {
    return [...this.sessions.values()].filter(
      s => s.callerAddress === caller && s.status === 'active' && Date.now() < s.expiresAt
    );
  }
}
