import type { ProviderCandidate, RouterConfig, RoutingStrategy } from './types.js';

export class ReputationRouter {
  private config: Required<RouterConfig>;
  private cache = new Map<string, { score: number; ts: number }>();

  constructor(config: RouterConfig = {}) {
    this.config = {
      strategy: config.strategy ?? 'balanced',
      cacheTtlMs: config.cacheTtlMs ?? 300_000,
      minReputation: config.minReputation ?? 10,
    };
  }

  /** Select best provider from candidates */
  select(candidates: ProviderCandidate[]): ProviderCandidate | undefined {
    const eligible = candidates.filter(c => c.reputation >= this.config.minReputation);
    if (!eligible.length) return undefined;

    switch (this.config.strategy) {
      case 'cheapest': return this.byCheapest(eligible);
      case 'fastest': return this.byFastest(eligible);
      case 'highest-reputation': return this.byReputation(eligible);
      case 'balanced': return this.byBalanced(eligible);
    }
  }

  /** Rank all candidates by strategy */
  rank(candidates: ProviderCandidate[]): ProviderCandidate[] {
    const eligible = candidates.filter(c => c.reputation >= this.config.minReputation);
    return eligible.sort((a, b) => this.score(b) - this.score(a));
  }

  private score(c: ProviderCandidate): number {
    // Balanced: normalize reputation (0-100), inverse price, inverse latency
    const repScore = c.reputation / 100;
    const priceScore = 1 / (1 + c.price / 10000); // lower price = higher score
    const latencyScore = 1 / (1 + (c.latencyMs ?? 500) / 1000);
    return repScore * 0.4 + priceScore * 0.35 + latencyScore * 0.25;
  }

  private byCheapest(c: ProviderCandidate[]): ProviderCandidate {
    return c.reduce((a, b) => a.price < b.price ? a : b);
  }

  private byFastest(c: ProviderCandidate[]): ProviderCandidate {
    return c.reduce((a, b) => (a.latencyMs ?? Infinity) < (b.latencyMs ?? Infinity) ? a : b);
  }

  private byReputation(c: ProviderCandidate[]): ProviderCandidate {
    return c.reduce((a, b) => a.reputation > b.reputation ? a : b);
  }

  private byBalanced(c: ProviderCandidate[]): ProviderCandidate {
    return c.reduce((a, b) => this.score(a) > this.score(b) ? a : b);
  }
}
