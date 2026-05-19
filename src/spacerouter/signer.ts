/**
 * SpaceRouter EIP-712 signer abstraction.
 *
 * Three implementations:
 *  - KeypairSpaceRouterSigner — raw private key (Node.js, scripts).
 *  - OWSSpaceRouterSigner     — bridges existing OWSWallet (multi-chain identity reuse).
 *  - BrowserSpaceRouterSigner — viem WalletClient (MetaMask, Rabby, wagmi).
 *
 * The EIP-712 domain + types match the SpaceRouter v1.5 leg-1 receipt schema.
 * Receipts are signed once per request and submitted to the gateway management API
 * (POST /leg1/submit). The schema is intentionally narrow: it commits the request
 * to the consumer wallet, gateway, request UUID, byte count, and price.
 */
import { privateKeyToAccount } from 'viem/accounts';
import type { Account, Hex, TypedDataDomain, WalletClient } from 'viem';
import type { OWSWallet } from '../ows/wallet.js';
import { NPaymentError } from '../errors.js';

// ─── EIP-712 schema (SpaceRouter v1.5) ──────────────────────────────────────

export function spaceRouterDomain(chainId: number, escrowContract: string): TypedDataDomain {
  return {
    name: 'SpaceRouterPayment',
    version: '1',
    chainId,
    verifyingContract: escrowContract as Hex,
  };
}

export const SPACEROUTER_RECEIPT_TYPES = {
  Receipt: [
    { name: 'consumer',    type: 'address' },
    { name: 'gateway',     type: 'address' },
    { name: 'requestUuid', type: 'bytes16' },
    { name: 'bytesServed', type: 'uint64' },
    { name: 'priceWei',    type: 'uint256' },
    { name: 'expiresAt',   type: 'uint64' },
  ],
} as const;

export interface SpaceRouterReceipt {
  consumer: Hex;
  gateway: Hex;
  requestUuid: Hex; // bytes16
  bytesServed: bigint;
  priceWei: bigint;
  expiresAt: bigint;
}

// ─── Signer interface ───────────────────────────────────────────────────────

export interface SpaceRouterSigner {
  /** Returns the consumer address (lowercase 0x... hex). */
  getAddress(): Promise<Hex>;
  /** Sign a SpaceRouter EIP-712 receipt. Returns the 65-byte signature as 0x... hex. */
  signReceipt(domain: TypedDataDomain, receipt: SpaceRouterReceipt): Promise<Hex>;
}

// ─── Keypair (Node.js) ──────────────────────────────────────────────────────

export class KeypairSpaceRouterSigner implements SpaceRouterSigner {
  private readonly account: Account;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }

  async getAddress(): Promise<Hex> {
    return this.account.address.toLowerCase() as Hex;
  }

  async signReceipt(domain: TypedDataDomain, receipt: SpaceRouterReceipt): Promise<Hex> {
    if (!this.account.signTypedData) {
      throw new NPaymentError('viem account missing signTypedData', 'SR_SIGNER_INVALID');
    }
    return this.account.signTypedData({
      domain,
      types: SPACEROUTER_RECEIPT_TYPES,
      primaryType: 'Receipt',
      message: receipt,
    });
  }
}

// ─── OWS bridge ─────────────────────────────────────────────────────────────

/**
 * Bridges an OWSWallet into the SpaceRouterSigner shape.
 * Reuses OWSWallet.getAccount() (viem LocalAccount) when a private key is configured.
 * CLI-driver-only mode is rejected with a clear error so callers can fall back to Keypair.
 */
export class OWSSpaceRouterSigner implements SpaceRouterSigner {
  constructor(private readonly wallet: OWSWallet, private readonly chainId: number) {}

  async getAddress(): Promise<Hex> {
    const addr = await this.wallet.getAddressAsync(this.chainId);
    return addr.toLowerCase() as Hex;
  }

  async signReceipt(domain: TypedDataDomain, receipt: SpaceRouterReceipt): Promise<Hex> {
    const account = this.wallet.getAccount();
    if (!account?.signTypedData) {
      throw new NPaymentError(
        'OWSSpaceRouterSigner needs a private-key-backed OWS wallet for EIP-712 typed data',
        'SR_SIGNER_NO_TYPED_DATA',
        'Pass ows.privateKey, or use KeypairSpaceRouterSigner / BrowserSpaceRouterSigner.',
      );
    }
    return account.signTypedData({
      domain,
      types: SPACEROUTER_RECEIPT_TYPES,
      primaryType: 'Receipt',
      message: receipt,
    });
  }
}

// ─── Browser (viem WalletClient) ────────────────────────────────────────────

export class BrowserSpaceRouterSigner implements SpaceRouterSigner {
  constructor(private readonly client: WalletClient, private readonly account: Hex) {}

  async getAddress(): Promise<Hex> {
    return this.account.toLowerCase() as Hex;
  }

  async signReceipt(domain: TypedDataDomain, receipt: SpaceRouterReceipt): Promise<Hex> {
    return this.client.signTypedData({
      account: this.account,
      domain,
      types: SPACEROUTER_RECEIPT_TYPES,
      primaryType: 'Receipt',
      message: receipt,
    });
  }
}
