import type { NegotiationResult, NegotiationPolicy, PaymentTerms } from './types.js';

export class PaymentNegotiator {
  private policy: Required<NegotiationPolicy>;

  constructor(policy: NegotiationPolicy = {}) {
    this.policy = {
      creditThreshold: policy.creditThreshold ?? 80,
      escrowThreshold: policy.escrowThreshold ?? 50000, // $0.05 USDC
      preferred: policy.preferred ?? ['direct', 'escrow', 'credit'],
    };
  }

  /** Negotiate payment terms based on reputation and task value */
  negotiate(price: number, callerReputation: number): NegotiationResult {
    // High reputation + any value → credit (pay after delivery)
    if (callerReputation >= this.policy.creditThreshold) {
      return { terms: 'credit', price, reason: `Reputation ${callerReputation} >= credit threshold` };
    }

    // High value + low reputation → escrow (ERC-8183)
    if (price >= this.policy.escrowThreshold && callerReputation < this.policy.creditThreshold) {
      return { terms: 'escrow', price, reason: `High value ${price} with reputation ${callerReputation}` };
    }

    // Default → direct payment (x402/MPP)
    return { terms: 'direct', price, reason: 'Standard direct payment' };
  }

  /** Provider-side: decide what terms to offer */
  offerTerms(price: number, callerReputation: number, providerPreferred?: PaymentTerms[]): NegotiationResult {
    const preferred = providerPreferred ?? this.policy.preferred;

    for (const terms of preferred) {
      if (terms === 'credit' && callerReputation >= this.policy.creditThreshold) {
        return { terms, price, reason: 'Credit offered to trusted agent' };
      }
      if (terms === 'direct' && price < this.policy.escrowThreshold) {
        return { terms, price, reason: 'Direct payment for low-value call' };
      }
      if (terms === 'escrow') {
        return { terms, price, reason: 'Escrow required' };
      }
    }

    return { terms: 'direct', price, reason: 'Fallback to direct' };
  }
}
