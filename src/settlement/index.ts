import type { ChainKey } from '../types.js';
import { NPaymentError } from '../errors.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface BatchSessionConfig {
  chain: ChainKey;
  budget: bigint;
  escrowContract: string;
  ceilingPerRequest?: bigint;
  autoSettleThreshold?: number; // % of budget
}

export interface BatchVoucher {
  sessionId: string;
  cumulativeAmount: bigint;
  nonce: number;
  signature: string;
  timestamp: number;
}

export interface BatchSession {
  id: string;
  chain: ChainKey;
  budget: bigint;
  cumulativeSpent: bigint;
  nonce: number;
  status: 'active' | 'settling' | 'settled' | 'withdrawn';
  createdAt: number;
  expiresAt: number;
}

export interface StreamConfig {
  provider: string;
  chain: ChainKey;
  budget: bigint;
  intervalMs?: number;
  maxPerInterval?: bigint;
}

export interface StreamSession {
  id: string;
  config: StreamConfig;
  totalUsage: bigint;
  intervalUsage: bigint;
  lastSettledAt: number;
  status: 'active' | 'paused' | 'cancelled' | 'exhausted';
}

export interface Permit2Params {
  token: string;
  amount: bigint;
  spender: string;
  nonce: bigint;
  deadline: number;
}

// ─── Batch Settlement ──────────────────────────────────────────────────────────

export class BatchSettlementManager {
  private sessions = new Map<string, BatchSession>();

  openSession(config: BatchSessionConfig): BatchSession {
    const session: BatchSession = {
      id: `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      chain: config.chain,
      budget: config.budget,
      cumulativeSpent: 0n,
      nonce: 0,
      status: 'active',
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  signVoucher(sessionId: string, amount: bigint): BatchVoucher {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') {
      throw new NPaymentError('Session not active', 'BATCH_INVALID_SESSION');
    }
    const newCumulative = session.cumulativeSpent + amount;
    if (newCumulative > session.budget) {
      throw new NPaymentError('Exceeds session budget', 'BATCH_OVER_BUDGET');
    }
    session.cumulativeSpent = newCumulative;
    session.nonce++;
    // EIP-712 signature placeholder — real impl signs with wallet
    const signature = `0x${session.nonce.toString(16).padStart(64, '0')}`;
    return {
      sessionId,
      cumulativeAmount: newCumulative,
      nonce: session.nonce,
      signature,
      timestamp: Date.now(),
    };
  }

  verifyVoucher(voucher: BatchVoucher): boolean {
    const session = this.sessions.get(voucher.sessionId);
    if (!session) return false;
    return voucher.cumulativeAmount <= session.budget && voucher.nonce > 0;
  }

  settle(sessionId: string): BatchSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) session.status = 'settled';
    return session;
  }

  shouldSettle(sessionId: string, threshold = 80): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return Number((session.cumulativeSpent * 100n) / session.budget) >= threshold;
  }

  getSession(id: string): BatchSession | undefined {
    return this.sessions.get(id);
  }
}

// ─── Streaming Payments ────────────────────────────────────────────────────────

export class StreamingPaymentManager {
  private streams = new Map<string, StreamSession>();

  createStream(config: StreamConfig): StreamSession {
    const stream: StreamSession = {
      id: `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      config: { intervalMs: 60_000, ...config },
      totalUsage: 0n,
      intervalUsage: 0n,
      lastSettledAt: Date.now(),
      status: 'active',
    };
    this.streams.set(stream.id, stream);
    return stream;
  }

  recordUsage(streamId: string, amount: bigint): void {
    const stream = this.streams.get(streamId);
    if (!stream || stream.status !== 'active') {
      throw new NPaymentError('Stream not active', 'STREAM_INACTIVE');
    }
    if (stream.totalUsage + amount > stream.config.budget) {
      stream.status = 'exhausted';
      throw new NPaymentError('Stream budget exhausted', 'STREAM_EXHAUSTED');
    }
    if (stream.config.maxPerInterval && stream.intervalUsage + amount > stream.config.maxPerInterval) {
      throw new NPaymentError('Exceeds interval limit', 'STREAM_RATE_LIMITED');
    }
    stream.totalUsage += amount;
    stream.intervalUsage += amount;
  }

  settleInterval(streamId: string): { settled: bigint } {
    const stream = this.streams.get(streamId);
    if (!stream) throw new NPaymentError('Stream not found', 'STREAM_NOT_FOUND');
    const settled = stream.intervalUsage;
    stream.intervalUsage = 0n;
    stream.lastSettledAt = Date.now();
    return { settled };
  }

  cancelStream(streamId: string): { refund: bigint } {
    const stream = this.streams.get(streamId);
    if (!stream) throw new NPaymentError('Stream not found', 'STREAM_NOT_FOUND');
    stream.status = 'cancelled';
    return { refund: stream.config.budget - stream.totalUsage };
  }

  getStream(id: string): StreamSession | undefined {
    return this.streams.get(id);
  }

  getActiveStreams(): StreamSession[] {
    return [...this.streams.values()].filter(s => s.status === 'active');
  }
}

// ─── Permit2 Signer ────────────────────────────────────────────────────────────

export class Permit2Signer {
  static readonly PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  /** Build EIP-712 typed data for Permit2 single transfer */
  buildPermitTypedData(params: Permit2Params, chainId: number) {
    return {
      domain: {
        name: 'Permit2',
        chainId,
        verifyingContract: Permit2Signer.PERMIT2_ADDRESS,
      },
      types: {
        PermitSingle: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
          { name: 'nonce', type: 'uint48' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      value: {
        token: params.token,
        amount: params.amount,
        expiration: params.deadline,
        nonce: params.nonce,
        spender: params.spender,
        sigDeadline: BigInt(params.deadline),
      },
    };
  }

  /** Build batch permit typed data for multiple tokens */
  buildBatchPermitTypedData(params: Permit2Params[], chainId: number) {
    return {
      domain: {
        name: 'Permit2',
        chainId,
        verifyingContract: Permit2Signer.PERMIT2_ADDRESS,
      },
      types: {
        PermitBatch: [
          { name: 'tokens', type: 'address[]' },
          { name: 'amounts', type: 'uint160[]' },
          { name: 'nonce', type: 'uint48' },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      value: {
        tokens: params.map(p => p.token),
        amounts: params.map(p => p.amount),
        nonce: params[0]?.nonce ?? 0n,
        spender: params[0]?.spender ?? '',
        sigDeadline: BigInt(params[0]?.deadline ?? 0),
      },
    };
  }
}
