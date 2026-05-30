/**
 * Flare gasless FXRP payments — client + deploy helper (v0.19).
 *
 * Flare's gasless flow is *not* x402. It uses a custom EIP-712 forwarder:
 *
 *   contract GaslessPaymentForwarder
 *     domain: { name: "GaslessPaymentForwarder", version: "1",
 *               chainId, verifyingContract: forwarderAddress }
 *     type:   PaymentRequest(from, to, amount, nonce, deadline)
 *
 * Flow:
 *   1. User does one-time `approve(forwarder, MaxUint256)` on FXRP.
 *   2. User signs PaymentRequest off-chain.
 *   3. Relayer (run by service operator) calls `executePayment(...)` and
 *      pays FLR for gas.
 *   4. Forwarder verifies signer == from, increments nonce, transfers FXRP.
 *
 * This module exports:
 *   - FlareGaslessForwarderClient — buyer-side client (status/approve/sign/submit/pay)
 *   - createGaslessRelayerHandler — Express-compatible relayer handler factory
 *   - deployFlareGaslessForwarder — one-shot viem deploy from caller artifacts
 *
 * Both client and relayer are tiny because all the contract logic lives in
 * Flare's published GaslessPaymentForwarder.sol — we only do EIP-712 signing,
 * HTTP transport, and a thin sponsored writeContract.
 *
 * Reference: https://dev.flare.network/fxrp/token-interactions/gasless-fxrp-payments
 */
import { recoverTypedDataAddress } from 'viem';
import type {
  Abi,
  Account,
  Address,
  Hex,
  PublicClient,
  TypedDataDomain,
  WalletClient,
} from 'viem';
import { NPaymentError } from '../errors.js';

// ─── Public types ────────────────────────────────────────────────────────────

export interface FlareGaslessClientConfig {
  publicClient: PublicClient;
  /** Wallet client whose `account` is the buyer signing PaymentRequests. */
  walletClient: WalletClient;
  forwarderAddress: Address;
  /** Relayer base URL (must expose POST /execute and GET /nonce/:addr). */
  relayerUrl: string;
  /** Default deadline window in seconds. @default 1800 (30 min) */
  deadlineSeconds?: number;
}

export interface FlarePaymentRequest {
  from: Address;
  to: Address;
  amount: string;       // base-10 stringified bigint
  deadline: number;     // unix seconds
  signature: Hex;
}

export interface FlareGaslessStatus {
  fxrpAddress: Address;
  decimals: number;
  balance: bigint;
  allowance: bigint;
  nonce: bigint;
  needsApproval: boolean;
}

export interface FlareGaslessExecuteResult {
  success: boolean;
  transactionHash: Hex;
  blockNumber: number | null;
  gasUsed: string;
}

export interface DeployFlareGaslessParams {
  walletClient: WalletClient;
  publicClient: PublicClient;
  artifact: { abi: Abi; bytecode: Hex };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_DEADLINE_SECONDS = 1800;
const MAX_UINT256 = (1n << 256n) - 1n;

/** EIP-712 type definition for PaymentRequest — exact match to Flare's contract. */
export const PAYMENT_REQUEST_TYPES = {
  PaymentRequest: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** Minimal forwarder ABI — only the entry-points the client + relayer use. */
const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'fxrp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'getNonce',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'executePayment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

/** Minimal ERC-20 read+approve ABI. */
const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi;

// ─── Buyer client ────────────────────────────────────────────────────────────

/**
 * Off-chain signer + relayer client for Flare's GaslessPaymentForwarder.
 *
 * Single responsibility: produce signed PaymentRequests and ship them over
 * HTTP to a relayer. Does *not* run a relayer or pay gas itself.
 */
export class FlareGaslessForwarderClient {
  private fxrpCache?: { address: Address; decimals: number };

  constructor(private readonly config: FlareGaslessClientConfig) {}

  /** Read balance + allowance + nonce for `userAddress`. */
  async getStatus(userAddress: Address): Promise<FlareGaslessStatus> {
    const { publicClient, forwarderAddress } = this.config;
    const fxrp = await this.resolveFxrp();
    const [balance, allowance, nonce] = await Promise.all([
      publicClient.readContract({
        address: fxrp.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [userAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: fxrp.address,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [userAddress, forwarderAddress],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: forwarderAddress,
        abi: FORWARDER_ABI,
        functionName: 'getNonce',
        args: [userAddress],
      }) as Promise<bigint>,
    ]);
    return {
      fxrpAddress: fxrp.address,
      decimals: fxrp.decimals,
      balance,
      allowance,
      nonce,
      needsApproval: allowance === 0n,
    };
  }

  /**
   * One-time approve of the forwarder to pull FXRP. Caller must have FLR for
   * gas on this single tx; subsequent payments are gasless.
   */
  async approve(amount: bigint = MAX_UINT256): Promise<Hex> {
    const { walletClient, publicClient, forwarderAddress } = this.config;
    const fxrp = await this.resolveFxrp();
    const account = this.requireAccount();
    const txHash = (await walletClient.writeContract({
      address: fxrp.address,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [forwarderAddress, amount],
      account,
      chain: walletClient.chain ?? null,
    } as never)) as Hex;
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    return txHash;
  }

  /** Sign a PaymentRequest. Uses the chain's latest block timestamp for `deadline` to avoid clock skew. */
  async createAndSign(params: {
    to: Address;
    /** Raw FXRP units (drops). For human input use parseAmount. */
    amount: bigint;
    deadlineSeconds?: number;
  }): Promise<FlarePaymentRequest> {
    const { publicClient, walletClient, forwarderAddress } = this.config;
    const account = this.requireAccount();
    const chainId = await publicClient.getChainId();
    const nonce = (await publicClient.readContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: 'getNonce',
      args: [account.address],
    })) as bigint;
    const block = await publicClient.getBlock();
    const chainTime = Number(block.timestamp ?? Math.floor(Date.now() / 1000));
    const deadline = chainTime + (params.deadlineSeconds ?? this.config.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS);

    const domain: TypedDataDomain = {
      name: 'GaslessPaymentForwarder',
      version: '1',
      chainId,
      verifyingContract: forwarderAddress,
    };
    const message = {
      from: account.address,
      to: params.to,
      amount: params.amount,
      nonce,
      deadline: BigInt(deadline),
    };
    const signature = (await walletClient.signTypedData({
      account,
      domain,
      types: PAYMENT_REQUEST_TYPES,
      primaryType: 'PaymentRequest',
      message,
    } as never)) as Hex;
    return {
      from: account.address,
      to: params.to,
      amount: params.amount.toString(),
      deadline,
      signature,
    };
  }

  /** POST a signed PaymentRequest to the relayer's /execute endpoint. */
  async submitToRelayer(req: FlarePaymentRequest): Promise<FlareGaslessExecuteResult> {
    const url = `${this.config.relayerUrl.replace(/\/$/, '')}/execute`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<FlareGaslessExecuteResult> & {
      error?: string;
    };
    if (!res.ok || !body.transactionHash) {
      throw new NPaymentError(
        `Flare gasless relayer rejected payment: ${body.error ?? res.statusText}`,
        'FLARE_GASLESS_RELAYER_REJECTED',
        'Verify forwarder address, network/chainId, FXRP balance + allowance, and that the deadline is in the future.',
      );
    }
    return {
      success: body.success ?? true,
      transactionHash: body.transactionHash as Hex,
      blockNumber: body.blockNumber ?? null,
      gasUsed: body.gasUsed ?? '0',
    };
  }

  /** Convenience: createAndSign + submitToRelayer in one call. */
  async pay(params: { to: Address; amount: bigint; deadlineSeconds?: number }): Promise<FlareGaslessExecuteResult> {
    const signed = await this.createAndSign(params);
    return this.submitToRelayer(signed);
  }

  // ── Internals ──

  private async resolveFxrp(): Promise<{ address: Address; decimals: number }> {
    if (this.fxrpCache) return this.fxrpCache;
    const fxrpAddress = (await this.config.publicClient.readContract({
      address: this.config.forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: 'fxrp',
    })) as Address;
    const decimals = (await this.config.publicClient.readContract({
      address: fxrpAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
    })) as number;
    this.fxrpCache = { address: fxrpAddress, decimals: Number(decimals) };
    return this.fxrpCache;
  }

  private requireAccount(): Account {
    const account = this.config.walletClient.account;
    if (!account) {
      throw new NPaymentError(
        'walletClient has no account — required for signing PaymentRequests',
        'FLARE_GASLESS_NO_ACCOUNT',
        'Construct walletClient with `account: privateKeyToAccount(...)` or a connected JSON-RPC account.',
      );
    }
    return account as Account;
  }
}

// ─── Relayer-side handler factory ────────────────────────────────────────────

/**
 * Build an Express-compatible POST /execute handler that re-verifies the
 * EIP-712 signature off-chain (catches bad domain/nonce before paying gas)
 * and submits `executePayment(...)` from the sponsor wallet.
 *
 * Mounted by `examples/flare-gasless-relayer.ts`.
 */
export interface GaslessRelayerHandlerConfig {
  publicClient: PublicClient;
  /** Relayer wallet — pays FLR for gas. */
  sponsorClient: WalletClient;
  forwarderAddress: Address;
  /** Override receipt poll timeout (ms). @default 60_000 */
  receiptTimeoutMs?: number;
}

export function createGaslessExecutor(cfg: GaslessRelayerHandlerConfig) {
  const sponsorAccount = cfg.sponsorClient.account;
  if (!sponsorAccount) {
    throw new NPaymentError(
      'sponsorClient.account is required',
      'FLARE_GASLESS_NO_SPONSOR',
      'Pass a wallet client constructed with privateKeyToAccount(...) for the sponsor.',
    );
  }

  return async (req: FlarePaymentRequest): Promise<FlareGaslessExecuteResult> => {
    const { publicClient, sponsorClient, forwarderAddress } = cfg;
    const chainId = await publicClient.getChainId();
    const nonce = (await publicClient.readContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: 'getNonce',
      args: [req.from],
    })) as bigint;

    // Off-chain signature verification — fail fast before paying gas.
    const domain: TypedDataDomain = {
      name: 'GaslessPaymentForwarder',
      version: '1',
      chainId,
      verifyingContract: forwarderAddress,
    };
    const message = {
      from: req.from,
      to: req.to,
      amount: BigInt(req.amount),
      nonce,
      deadline: BigInt(req.deadline),
    };
    const recovered = await recoverTypedDataAddress({
      domain,
      types: PAYMENT_REQUEST_TYPES,
      primaryType: 'PaymentRequest',
      message,
      signature: req.signature,
    });
    if (recovered.toLowerCase() !== req.from.toLowerCase()) {
      throw new NPaymentError(
        `Signature recovers to ${recovered}, expected ${req.from}`,
        'FLARE_GASLESS_BAD_SIGNATURE',
        `Check chainId (expected ${chainId}), forwarder address, and nonce (expected ${nonce}).`,
      );
    }

    const block = await publicClient.getBlock();
    const chainTime = Number(block.timestamp);
    if (req.deadline <= chainTime) {
      throw new NPaymentError(
        `Payment expired (deadline ${req.deadline}, chain ${chainTime})`,
        'FLARE_GASLESS_EXPIRED',
        'Ask the buyer to re-sign with a fresh deadline.',
      );
    }

    const txHash = (await sponsorClient.writeContract({
      address: forwarderAddress,
      abi: FORWARDER_ABI,
      functionName: 'executePayment',
      args: [req.from, req.to, BigInt(req.amount), BigInt(req.deadline), req.signature],
      account: sponsorAccount,
      chain: sponsorClient.chain ?? null,
    } as never)) as Hex;
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: cfg.receiptTimeoutMs ?? 60_000,
    });
    if (receipt.status !== 'success') {
      throw new NPaymentError(
        `executePayment ${txHash} reverted`,
        'FLARE_GASLESS_REVERT',
        'Check FXRP allowance + balance for the buyer at the time of submission.',
      );
    }
    return {
      success: true,
      transactionHash: txHash,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed.toString(),
    };
  };
}

// ─── Deploy helper ───────────────────────────────────────────────────────────

/**
 * Deploy GaslessPaymentForwarder to the connected Flare network. Caller
 * supplies the compiled artifact; the contract has no constructor args
 * (FXRP is resolved on-chain via FlareContractRegistry inside the contract).
 *
 * Source: https://github.com/flare-foundation/flare-hardhat-starter
 */
export async function deployFlareGaslessForwarder(
  params: DeployFlareGaslessParams,
): Promise<{ forwarderAddress: Address }> {
  const { walletClient, publicClient, artifact } = params;
  const txHash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    account: walletClient.account ?? null,
    chain: walletClient.chain ?? null,
  } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (!receipt.contractAddress) {
    throw new NPaymentError('GaslessPaymentForwarder deploy receipt has no contractAddress', 'FLARE_GASLESS_DEPLOY_FAILED');
  }
  return { forwarderAddress: receipt.contractAddress as Address };
}

export { FORWARDER_ABI };
