import type { DelegationContext, DelegationConfig } from './types.js';
import type { ChainKey } from '../types.js';
import { NPaymentError } from '../errors.js';

export class DelegationManager {
  private config: Required<DelegationConfig>;
  private contexts = new Map<string, DelegationContext>();

  constructor(config: DelegationConfig = {}) {
    this.config = {
      maxDepth: config.maxDepth ?? 5,
      maxPerHopPercent: config.maxPerHopPercent ?? 80,
    };
  }

  /** Create root delegation context */
  createRoot(budget: number, chain: ChainKey): DelegationContext {
    const ctx: DelegationContext = {
      rootId: `del_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      depth: 0,
      totalBudget: budget,
      remainingBudget: budget,
      maxDepth: this.config.maxDepth,
      chain,
    };
    this.contexts.set(ctx.rootId, ctx);
    return ctx;
  }

  /** Create child delegation from parent */
  delegate(parent: DelegationContext, amount: number): DelegationContext {
    if (parent.depth >= parent.maxDepth) {
      throw new NPaymentError(`Max delegation depth ${parent.maxDepth} reached`, 'DELEGATION_MAX_DEPTH');
    }
    const maxAllowed = parent.remainingBudget * (this.config.maxPerHopPercent / 100);
    if (amount > maxAllowed) {
      throw new NPaymentError(`Amount ${amount} exceeds max per-hop ${maxAllowed}`, 'DELEGATION_OVER_BUDGET');
    }
    if (amount > parent.remainingBudget) {
      throw new NPaymentError(`Amount ${amount} exceeds remaining ${parent.remainingBudget}`, 'DELEGATION_INSUFFICIENT');
    }

    parent.remainingBudget -= amount;

    const child: DelegationContext = {
      parentId: parent.rootId,
      rootId: parent.rootId,
      depth: parent.depth + 1,
      totalBudget: amount,
      remainingBudget: amount,
      maxDepth: parent.maxDepth,
      chain: parent.chain,
    };
    return child;
  }

  /** Record spend against a delegation context */
  spend(ctx: DelegationContext, amount: number): boolean {
    if (amount > ctx.remainingBudget) return false;
    ctx.remainingBudget -= amount;
    return true;
  }

  getContext(rootId: string): DelegationContext | undefined {
    return this.contexts.get(rootId);
  }
}
