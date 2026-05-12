import { NPaymentError } from '../errors.js';
import type { StellarWallet } from './wallet.js';

export interface TrustlessWorkConfig {
  apiUrl?: string; // defaults to testnet
  apiKey?: string;
}

export interface EscrowDeployParams {
  title: string;
  description?: string;
  amount: string;
  receiver: string;
  serviceProvider: string;
  approver: string;
  releaseSigner: string;
  platformAddress?: string;
  platformFee?: string;
  milestones: { description: string; amount?: string }[];
}

export interface EscrowStatus {
  contractId: string;
  balance: string;
  funded: boolean;
  milestones: { status: string; approved: boolean }[];
}

const TESTNET_URL = 'https://dev.api.trustlesswork.com';
const MAINNET_URL = 'https://api.trustlesswork.com';

/**
 * Lightweight REST client for Trustless Work escrow API.
 * All write operations return unsigned XDR for client-side signing.
 */
export class TrustlessWorkClient {
  private baseUrl: string;
  private apiKey?: string;

  constructor(config: TrustlessWorkConfig = {}) {
    this.baseUrl = config.apiUrl ?? TESTNET_URL;
    this.apiKey = config.apiKey;
  }

  /** Deploy a single-release escrow */
  async deploySingleRelease(params: EscrowDeployParams): Promise<{ contractId: string; unsignedXdr: string }> {
    return this.post('/deployer/single-release', params);
  }

  /** Deploy a multi-release escrow */
  async deployMultiRelease(params: EscrowDeployParams): Promise<{ contractId: string; unsignedXdr: string }> {
    return this.post('/deployer/multi-release', params);
  }

  /** Fund an escrow */
  async fundEscrow(contractId: string, type: 'single' | 'multi' = 'single'): Promise<{ unsignedXdr: string }> {
    return this.post(`/escrow/${type}-release/fund-escrow`, { contractId });
  }

  /** Change milestone status */
  async changeMilestoneStatus(contractId: string, milestoneIndex: number, status: string, type: 'single' | 'multi' = 'single'): Promise<{ unsignedXdr: string }> {
    return this.post(`/escrow/${type}-release/change-milestone-status`, { contractId, milestoneIndex, status });
  }

  /** Approve a milestone */
  async approveMilestone(contractId: string, milestoneIndex: number, type: 'single' | 'multi' = 'single'): Promise<{ unsignedXdr: string }> {
    return this.post(`/escrow/${type}-release/approve-milestone`, { contractId, milestoneIndex });
  }

  /** Release funds (single-release) */
  async releaseFunds(contractId: string): Promise<{ unsignedXdr: string }> {
    return this.post('/escrow/single-release/release-funds', { contractId });
  }

  /** Release milestone funds (multi-release) */
  async releaseMilestoneFunds(contractId: string, milestoneIndex: number): Promise<{ unsignedXdr: string }> {
    return this.post('/escrow/multi-release/release-milestone-funds', { contractId, milestoneIndex });
  }

  /** Dispute an escrow */
  async disputeEscrow(contractId: string, type: 'single' | 'multi' = 'single'): Promise<{ unsignedXdr: string }> {
    return this.post(`/escrow/${type}-release/dispute-escrow`, { contractId });
  }

  /** Resolve a dispute */
  async resolveDispute(contractId: string, type: 'single' | 'multi' = 'single'): Promise<{ unsignedXdr: string }> {
    return this.post(`/escrow/${type}-release/resolve-dispute`, { contractId });
  }

  /** Get escrow balance */
  async getBalance(contractId: string): Promise<EscrowStatus> {
    return this.get(`/escrow/get-multiple-escrow-balance?contractIds=${contractId}`);
  }

  /** Sign and submit an unsigned XDR transaction */
  async signAndSubmit(unsignedXdr: string, wallet: StellarWallet, networkPassphrase: string): Promise<string> {
    const signedXdr = await wallet.signTransaction(unsignedXdr, networkPassphrase);
    const result = await this.post<{ hash: string }>('/helper/send-transaction', { signedXdr });
    return result.hash;
  }

  private async post<T = any>(path: string, body: any): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new NPaymentError(`Trustless Work API error: ${res.status}`, 'TRUSTLESS_WORK_ERROR');
    return res.json();
  }

  private async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) throw new NPaymentError(`Trustless Work API error: ${res.status}`, 'TRUSTLESS_WORK_ERROR');
    return res.json();
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }
}
