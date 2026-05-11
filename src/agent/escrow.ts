import type { Job, EscrowConfig, JobStatus } from './types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { NPaymentError } from '../errors.js';

const JOB_ABI = {
  createJob: '0xa1b2c3d4',
  fundJob: '0xe5f6a7b8',
  submitDeliverable: '0xc9d0e1f2',
  completeJob: '0x34567890',
  rejectJob: '0xabcdef01',
} as const;

export class EscrowManager {
  private wallet: OWSWallet;
  private config: EscrowConfig;
  private jobs = new Map<string, Job>();

  constructor(wallet: OWSWallet, config: EscrowConfig) {
    this.wallet = wallet;
    this.config = config;
  }

  /** Create and fund a job in escrow */
  async createJob(provider: string, amount: number): Promise<Job> {
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const chainId = (await import('../chains.js')).CHAINS[this.config.chain].chainId;

    const data = `${JOB_ABI.createJob}${provider.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
    await this.wallet.signTransaction({ to: this.config.contractAddress, data }, chainId);

    const job: Job = {
      id,
      client: await this.wallet.getAddressAsync(chainId),
      provider,
      evaluator: this.config.evaluator,
      amount,
      chain: this.config.chain,
      status: 'funded',
      createdAt: Date.now(),
      expiresAt: Date.now() + (this.config.timeoutMs ?? 3600_000),
    };
    this.jobs.set(id, job);
    return job;
  }

  /** Provider submits deliverable hash */
  submitDeliverable(jobId: string, hash: string): Job {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'funded') throw new NPaymentError('Job not in funded state', 'ESCROW_INVALID_STATE');
    job.deliverableHash = hash;
    job.status = 'submitted';
    return job;
  }

  /** Evaluator approves — release funds to provider */
  async complete(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'submitted') throw new NPaymentError('Job not in submitted state', 'ESCROW_INVALID_STATE');

    const chainId = (await import('../chains.js')).CHAINS[this.config.chain].chainId;
    const data = `${JOB_ABI.completeJob}${job.id.replace(/[^a-f0-9]/gi, '').padStart(64, '0')}`;
    await this.wallet.signTransaction({ to: this.config.contractAddress, data }, chainId);

    job.status = 'completed';
    return job;
  }

  /** Evaluator rejects — refund to client */
  async reject(jobId: string): Promise<Job> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'submitted') throw new NPaymentError('Job not in submitted state', 'ESCROW_INVALID_STATE');

    const chainId = (await import('../chains.js')).CHAINS[this.config.chain].chainId;
    const data = `${JOB_ABI.rejectJob}${job.id.replace(/[^a-f0-9]/gi, '').padStart(64, '0')}`;
    await this.wallet.signTransaction({ to: this.config.contractAddress, data }, chainId);

    job.status = 'rejected';
    return job;
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }
}
