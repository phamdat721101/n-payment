import { NPaymentError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface AP2Config {
  agentId: string;
  signingKey?: string;
}

export interface MandateConstraints {
  maxBudget?: bigint;
  allowedCategories?: string[];
  allowedRecipients?: string[];
  expiresAt?: number;
}

export interface CartDetails {
  items: Array<{ name: string; price: bigint; quantity: number }>;
  total: bigint;
  merchant: string;
}

export interface CheckoutMandate {
  id: string;
  type: 'open' | 'closed';
  agentId: string;
  constraints?: MandateConstraints;
  cart?: CartDetails;
  signature: string;
  createdAt: number;
  expiresAt: number;
}

export interface PaymentMandate {
  id: string;
  type: 'open' | 'closed';
  checkoutMandateId: string;
  amount: bigint;
  instrument: 'x402' | 'mpp' | 'card' | 'nanopayment';
  signature: string;
  createdAt: number;
}

export interface VerifiableIntent {
  id: string;
  agentId: string;
  action: string;
  constraints: Record<string, unknown>;
  parentId?: string;
  signature: string;
  timestamp: number;
  expiresAt: number;
}

// ─── AP2 Client ────────────────────────────────────────────────────────────────

export class AP2Client {
  private config: AP2Config;
  private mandates = new Map<string, CheckoutMandate>();

  constructor(config: AP2Config) {
    this.config = config;
  }

  /** Create an open checkout mandate (user sets constraints, agent shops freely) */
  createCheckoutMandate(constraints: MandateConstraints): CheckoutMandate {
    const mandate: CheckoutMandate = {
      id: `cm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'open',
      agentId: this.config.agentId,
      constraints,
      signature: this.sign(`checkout:open:${JSON.stringify(constraints)}`),
      createdAt: Date.now(),
      expiresAt: constraints.expiresAt ?? Date.now() + 3600_000,
    };
    this.mandates.set(mandate.id, mandate);
    return mandate;
  }

  /** Close a checkout mandate by binding to specific cart */
  closeCheckoutMandate(mandateId: string, cart: CartDetails): CheckoutMandate {
    const mandate = this.mandates.get(mandateId);
    if (!mandate || mandate.type !== 'open') {
      throw new NPaymentError('Mandate not found or already closed', 'AP2_INVALID_MANDATE');
    }
    // Validate cart against constraints
    if (mandate.constraints?.maxBudget && cart.total > mandate.constraints.maxBudget) {
      throw new NPaymentError('Cart exceeds mandate budget', 'AP2_OVER_BUDGET');
    }
    mandate.type = 'closed';
    mandate.cart = cart;
    mandate.signature = this.sign(`checkout:closed:${mandate.id}:${cart.total}`);
    return mandate;
  }

  /** Create payment mandate bound to a closed checkout */
  createPaymentMandate(checkoutMandateId: string, amount: bigint, instrument: PaymentMandate['instrument']): PaymentMandate {
    const checkout = this.mandates.get(checkoutMandateId);
    if (!checkout || checkout.type !== 'closed') {
      throw new NPaymentError('Checkout mandate must be closed first', 'AP2_MANDATE_NOT_CLOSED');
    }
    return {
      id: `pm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'closed',
      checkoutMandateId,
      amount,
      instrument,
      signature: this.sign(`payment:${checkoutMandateId}:${amount}:${instrument}`),
      createdAt: Date.now(),
    };
  }

  /** Verify a mandate chain is valid */
  verifyMandateChain(checkout: CheckoutMandate, payment: PaymentMandate): boolean {
    if (payment.checkoutMandateId !== checkout.id) return false;
    if (checkout.type !== 'closed') return false;
    if (checkout.cart && payment.amount > checkout.cart.total) return false;
    if (Date.now() > checkout.expiresAt) return false;
    return true;
  }

  private sign(data: string): string {
    // Placeholder — real impl uses signingKey with EIP-712 or Ed25519
    const hash = Array.from(data).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    return `0x${Math.abs(hash).toString(16).padStart(64, '0')}`;
  }
}

// ─── Verifiable Intent ─────────────────────────────────────────────────────────

export class VerifiableIntentSigner {
  private agentId: string;

  constructor(agentId: string) {
    this.agentId = agentId;
  }

  /** Create a verifiable intent (user authorizes agent action) */
  create(action: string, constraints: Record<string, unknown>, ttlMs = 3600_000): VerifiableIntent {
    const intent: VerifiableIntent = {
      id: `vi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: this.agentId,
      action,
      constraints,
      signature: this.sign(`${action}:${JSON.stringify(constraints)}`),
      timestamp: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    return intent;
  }

  /** Chain a child intent to a parent (multi-step workflows) */
  chain(parent: VerifiableIntent, action: string, constraints: Record<string, unknown>): VerifiableIntent {
    const child = this.create(action, constraints);
    child.parentId = parent.id;
    child.signature = this.sign(`${parent.id}:${action}:${JSON.stringify(constraints)}`);
    return child;
  }

  /** Verify an intent is valid and not expired */
  verify(intent: VerifiableIntent): boolean {
    if (Date.now() > intent.expiresAt) return false;
    if (intent.agentId !== this.agentId) return false;
    return true;
  }

  private sign(data: string): string {
    const hash = Array.from(data).reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
    return `0x${Math.abs(hash).toString(16).padStart(64, '0')}`;
  }
}
