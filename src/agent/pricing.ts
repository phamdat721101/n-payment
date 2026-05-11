import type { PricingStrategy, PricingContext, PricingConfig } from './types.js';

/** Surge pricing based on request volume */
export class DemandStrategy implements PricingStrategy {
  private window: number[] = [];
  private windowMs: number;
  private surgeThreshold: number;
  private surgeMultiplier: number;

  constructor(opts: { windowMs?: number; threshold?: number; multiplier?: number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.surgeThreshold = opts.threshold ?? 100;
    this.surgeMultiplier = opts.multiplier ?? 2;
  }

  resolve(ctx: PricingContext): number {
    const now = Date.now();
    this.window = this.window.filter(t => now - t < this.windowMs);
    this.window.push(now);
    const demand = this.window.length;
    if (demand > this.surgeThreshold) {
      return ctx.basePrice * this.surgeMultiplier;
    }
    return ctx.basePrice;
  }
}

/** Discount for high-reputation callers, premium for unknown */
export class ReputationStrategy implements PricingStrategy {
  private discountThreshold: number;
  private discount: number;
  private premiumThreshold: number;
  private premium: number;

  constructor(opts: { discountAbove?: number; discount?: number; premiumBelow?: number; premium?: number } = {}) {
    this.discountThreshold = opts.discountAbove ?? 80;
    this.discount = opts.discount ?? 0.8; // 20% off
    this.premiumThreshold = opts.premiumBelow ?? 20;
    this.premium = opts.premium ?? 1.5; // 50% more
  }

  resolve(ctx: PricingContext): number {
    const rep = ctx.callerReputation ?? 50;
    if (rep >= this.discountThreshold) return ctx.basePrice * this.discount;
    if (rep <= this.premiumThreshold) return ctx.basePrice * this.premium;
    return ctx.basePrice;
  }
}

/** Base price + bonus for verified quality outcomes */
export class OutcomeStrategy implements PricingStrategy {
  private bonusPercent: number;

  constructor(opts: { bonusPercent?: number } = {}) {
    this.bonusPercent = opts.bonusPercent ?? 20;
  }

  resolve(ctx: PricingContext): number {
    // Outcome bonus is applied post-delivery; at pricing time return base
    return ctx.basePrice;
  }

  /** Calculate bonus amount after successful outcome verification */
  calculateBonus(basePrice: number): number {
    return Math.floor(basePrice * (this.bonusPercent / 100));
  }
}

/** Composable pricing engine — runs strategies in order, takes max */
export class PricingEngine {
  private strategies: PricingStrategy[];
  private min: number;
  private max: number;

  constructor(config: PricingConfig) {
    this.strategies = config.strategies ?? [];
    this.min = config.min ?? 0;
    this.max = config.max ?? Infinity;
  }

  resolve(ctx: PricingContext): number {
    if (!this.strategies.length) return ctx.basePrice;
    const prices = this.strategies.map(s => s.resolve(ctx));
    const price = Math.max(...prices);
    return Math.min(Math.max(price, this.min), this.max);
  }
}
