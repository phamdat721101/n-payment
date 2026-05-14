import { NPaymentError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type PolicyRuleType = 'spending_limit' | 'rate_limit' | 'allowlist' | 'blocklist';

export interface PolicyRule {
  id: string;
  type: PolicyRuleType;
  scope: 'global' | 'per_tool' | 'per_session';
  config: SpendingLimitConfig | RateLimitConfig | ListConfig;
}

export interface SpendingLimitConfig {
  maxPerTransaction: bigint;
  maxPerHour: bigint;
  maxPerDay: bigint;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface ListConfig {
  addresses: string[];
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; ruleId: string };

export interface PaymentRequest {
  url: string;
  amount: bigint;
  chain: string;
  tool?: string;
  recipient?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  type: 'payment' | 'policy_check' | 'settlement';
  amount?: bigint;
  chain?: string;
  tool?: string;
  url?: string;
  decision: PolicyDecision;
}

export interface PolicyConfig {
  maxPerTransaction?: bigint;
  maxPerHour?: bigint;
  maxPerDay?: bigint;
  rateLimit?: { maxRequests: number; windowMs: number };
  blocklist?: string[];
  allowlist?: string[];
}

// ─── Policy Engine ─────────────────────────────────────────────────────────────

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private hourlySpend = 0n;
  private dailySpend = 0n;
  private hourReset = Date.now() + 3600_000;
  private dayReset = Date.now() + 86400_000;
  private requestWindow: number[] = [];

  constructor(rules: PolicyRule[] = []) {
    this.rules = rules;
  }

  static fromConfig(config: PolicyConfig): PolicyEngine {
    const rules: PolicyRule[] = [];
    if (config.maxPerTransaction || config.maxPerHour || config.maxPerDay) {
      rules.push({
        id: 'spending',
        type: 'spending_limit',
        scope: 'global',
        config: {
          maxPerTransaction: config.maxPerTransaction ?? 1000000000n,
          maxPerHour: config.maxPerHour ?? 100000000n,
          maxPerDay: config.maxPerDay ?? 1000000000n,
        },
      });
    }
    if (config.rateLimit) {
      rules.push({
        id: 'rate',
        type: 'rate_limit',
        scope: 'global',
        config: config.rateLimit,
      });
    }
    if (config.blocklist?.length) {
      rules.push({ id: 'blocklist', type: 'blocklist', scope: 'global', config: { addresses: config.blocklist } });
    }
    if (config.allowlist?.length) {
      rules.push({ id: 'allowlist', type: 'allowlist', scope: 'global', config: { addresses: config.allowlist } });
    }
    return new PolicyEngine(rules);
  }

  evaluate(request: PaymentRequest): PolicyDecision {
    const now = Date.now();
    // Reset windows
    if (now > this.hourReset) { this.hourlySpend = 0n; this.hourReset = now + 3600_000; }
    if (now > this.dayReset) { this.dailySpend = 0n; this.dayReset = now + 86400_000; }

    for (const rule of this.rules) {
      const decision = this.evaluateRule(rule, request, now);
      if (!decision.allowed) return decision;
    }
    return { allowed: true };
  }

  recordSpend(amount: bigint): void {
    this.hourlySpend += amount;
    this.dailySpend += amount;
  }

  private evaluateRule(rule: PolicyRule, request: PaymentRequest, now: number): PolicyDecision {
    switch (rule.type) {
      case 'spending_limit': {
        const cfg = rule.config as SpendingLimitConfig;
        if (request.amount > cfg.maxPerTransaction)
          return { allowed: false, reason: `Exceeds max per tx: ${cfg.maxPerTransaction}`, ruleId: rule.id };
        if (this.hourlySpend + request.amount > cfg.maxPerHour)
          return { allowed: false, reason: 'Hourly spending limit reached', ruleId: rule.id };
        if (this.dailySpend + request.amount > cfg.maxPerDay)
          return { allowed: false, reason: 'Daily spending limit reached', ruleId: rule.id };
        return { allowed: true };
      }
      case 'rate_limit': {
        const cfg = rule.config as RateLimitConfig;
        this.requestWindow = this.requestWindow.filter(t => now - t < cfg.windowMs);
        if (this.requestWindow.length >= cfg.maxRequests)
          return { allowed: false, reason: 'Rate limit exceeded', ruleId: rule.id };
        this.requestWindow.push(now);
        return { allowed: true };
      }
      case 'blocklist': {
        const cfg = rule.config as ListConfig;
        if (request.recipient && cfg.addresses.includes(request.recipient))
          return { allowed: false, reason: `Recipient blocked: ${request.recipient}`, ruleId: rule.id };
        return { allowed: true };
      }
      case 'allowlist': {
        const cfg = rule.config as ListConfig;
        if (request.recipient && !cfg.addresses.includes(request.recipient))
          return { allowed: false, reason: `Recipient not in allowlist`, ruleId: rule.id };
        return { allowed: true };
      }
      default:
        return { allowed: true };
    }
  }
}

// ─── Audit Log ─────────────────────────────────────────────────────────────────

export class AuditLog {
  private entries: AuditEntry[] = [];

  record(entry: Omit<AuditEntry, 'id' | 'timestamp'>): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    this.entries.push(full);
    return full;
  }

  query(filter?: { type?: string; from?: number; to?: number }): AuditEntry[] {
    return this.entries.filter(e => {
      if (filter?.type && e.type !== filter.type) return false;
      if (filter?.from && e.timestamp < filter.from) return false;
      if (filter?.to && e.timestamp > filter.to) return false;
      return true;
    });
  }

  getSpendingSummary(periodMs = 86400_000): { total: bigint; count: number } {
    const since = Date.now() - periodMs;
    const relevant = this.entries.filter(e => e.type === 'payment' && e.timestamp >= since);
    const total = relevant.reduce((sum, e) => sum + (e.amount ?? 0n), 0n);
    return { total, count: relevant.length };
  }

  export(): AuditEntry[] {
    return [...this.entries];
  }
}

// ─── Spending Guard ────────────────────────────────────────────────────────────

export class SpendingGuard {
  constructor(
    private policy: PolicyEngine,
    private audit: AuditLog,
  ) {}

  check(request: PaymentRequest): PolicyDecision {
    const decision = this.policy.evaluate(request);
    this.audit.record({ type: 'policy_check', amount: request.amount, chain: request.chain, url: request.url, decision });
    return decision;
  }

  recordPayment(request: PaymentRequest): void {
    this.policy.recordSpend(request.amount);
    this.audit.record({
      type: 'payment',
      amount: request.amount,
      chain: request.chain,
      url: request.url,
      tool: request.tool,
      decision: { allowed: true },
    });
  }

  getAudit(): AuditLog {
    return this.audit;
  }
}
