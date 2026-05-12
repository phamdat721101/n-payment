import { TrustlessWorkClient, type TrustlessWorkConfig, type EscrowDeployParams } from './trustless-work.js';
import { StellarWallet } from './wallet.js';
import { NPaymentError } from '../errors.js';
import type { ChainKey } from '../types.js';

export type TrustlessJobStatus = 'created' | 'funded' | 'in-progress' | 'submitted' | 'approved' | 'released' | 'disputed' | 'resolved';

export interface TrustlessJob {
  id: string;
  contractId: string;
  type: 'single' | 'multi';
  client: string;
  provider: string;
  approver: string;
  amount: string;
  chain: ChainKey;
  status: TrustlessJobStatus;
  milestones: { description: string; amount?: string; status: string }[];
  createdAt: number;
}

export interface TrustlessEscrowConfig {
  chain: ChainKey;
  networkPassphrase?: string;
  trustlessWork?: TrustlessWorkConfig;
}

const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const STELLAR_MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * Manages agent-to-agent escrow jobs via Trustless Work on Stellar.
 * Supports single-release (one payout) and multi-release (milestone payouts).
 */
export class TrustlessEscrowManager {
  private client: TrustlessWorkClient;
  private wallet: StellarWallet;
  private chain: ChainKey;
  private passphrase: string;
  private jobs = new Map<string, TrustlessJob>();

  constructor(wallet: StellarWallet, config: TrustlessEscrowConfig) {
    this.wallet = wallet;
    this.chain = config.chain;
    this.passphrase = config.networkPassphrase ??
      (config.chain === 'stellar-mainnet' ? STELLAR_MAINNET_PASSPHRASE : STELLAR_TESTNET_PASSPHRASE);
    this.client = new TrustlessWorkClient(config.trustlessWork);
  }

  /** Create and deploy an escrow job */
  async createJob(params: {
    provider: string;
    approver?: string;
    amount: string;
    title: string;
    milestones: { description: string; amount?: string }[];
    type?: 'single' | 'multi';
  }): Promise<TrustlessJob> {
    const clientPubKey = await this.wallet.getPublicKey();
    const type = params.type ?? (params.milestones.length > 1 ? 'multi' : 'single');

    const deployParams: EscrowDeployParams = {
      title: params.title,
      amount: params.amount,
      receiver: params.provider,
      serviceProvider: params.provider,
      approver: params.approver ?? clientPubKey,
      releaseSigner: clientPubKey,
      milestones: params.milestones,
    };

    const deploy = type === 'multi'
      ? await this.client.deployMultiRelease(deployParams)
      : await this.client.deploySingleRelease(deployParams);

    await this.client.signAndSubmit(deploy.unsignedXdr, this.wallet, this.passphrase);

    const job: TrustlessJob = {
      id: `tw_${Date.now().toString(36)}`,
      contractId: deploy.contractId,
      type,
      client: clientPubKey,
      provider: params.provider,
      approver: params.approver ?? clientPubKey,
      amount: params.amount,
      chain: this.chain,
      status: 'created',
      milestones: params.milestones.map(m => ({ ...m, status: 'pending' })),
      createdAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  /** Fund an escrow job */
  async fundJob(jobId: string): Promise<TrustlessJob> {
    const job = this.getJobOrThrow(jobId, ['created']);
    const { unsignedXdr } = await this.client.fundEscrow(job.contractId, job.type);
    await this.client.signAndSubmit(unsignedXdr, this.wallet, this.passphrase);
    job.status = 'funded';
    return job;
  }

  /** Provider marks milestone as completed */
  async submitMilestone(jobId: string, milestoneIndex: number): Promise<TrustlessJob> {
    const job = this.getJobOrThrow(jobId, ['funded', 'in-progress']);
    const { unsignedXdr } = await this.client.changeMilestoneStatus(job.contractId, milestoneIndex, 'completed', job.type);
    await this.client.signAndSubmit(unsignedXdr, this.wallet, this.passphrase);
    job.milestones[milestoneIndex].status = 'completed';
    job.status = 'submitted';
    return job;
  }

  /** Approver approves milestone and releases funds */
  async approveAndRelease(jobId: string, milestoneIndex: number): Promise<TrustlessJob> {
    const job = this.getJobOrThrow(jobId, ['submitted', 'in-progress', 'funded']);

    const { unsignedXdr: approveXdr } = await this.client.approveMilestone(job.contractId, milestoneIndex, job.type);
    await this.client.signAndSubmit(approveXdr, this.wallet, this.passphrase);
    job.milestones[milestoneIndex].status = 'approved';

    if (job.type === 'multi') {
      const { unsignedXdr: releaseXdr } = await this.client.releaseMilestoneFunds(job.contractId, milestoneIndex);
      await this.client.signAndSubmit(releaseXdr, this.wallet, this.passphrase);
    } else {
      const allApproved = job.milestones.every(m => m.status === 'approved');
      if (allApproved) {
        const { unsignedXdr: releaseXdr } = await this.client.releaseFunds(job.contractId);
        await this.client.signAndSubmit(releaseXdr, this.wallet, this.passphrase);
      }
    }

    job.status = job.milestones.every(m => m.status === 'approved') ? 'released' : 'in-progress';
    return job;
  }

  /** Raise a dispute */
  async dispute(jobId: string): Promise<TrustlessJob> {
    const job = this.getJobOrThrow(jobId, ['funded', 'submitted', 'in-progress']);
    const { unsignedXdr } = await this.client.disputeEscrow(job.contractId, job.type);
    await this.client.signAndSubmit(unsignedXdr, this.wallet, this.passphrase);
    job.status = 'disputed';
    return job;
  }

  /** Resolve a dispute */
  async resolve(jobId: string): Promise<TrustlessJob> {
    const job = this.getJobOrThrow(jobId, ['disputed']);
    const { unsignedXdr } = await this.client.resolveDispute(job.contractId, job.type);
    await this.client.signAndSubmit(unsignedXdr, this.wallet, this.passphrase);
    job.status = 'resolved';
    return job;
  }

  getJob(id: string): TrustlessJob | undefined {
    return this.jobs.get(id);
  }

  private getJobOrThrow(id: string, validStatuses: TrustlessJobStatus[]): TrustlessJob {
    const job = this.jobs.get(id);
    if (!job) throw new NPaymentError(`Job not found: ${id}`, 'ESCROW_NOT_FOUND');
    if (!validStatuses.includes(job.status)) {
      throw new NPaymentError(`Job ${id} in invalid state: ${job.status}`, 'ESCROW_INVALID_STATE');
    }
    return job;
  }
}
