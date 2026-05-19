/**
 * SpaceRouterEscrowClient — on-chain lifecycle for $SPACE escrow on Creditcoin.
 *
 * Single responsibility: talk to TokenPaymentEscrow + the SPACE ERC-20.
 * - deposit / balance / max-rate read
 * - withdrawal lifecycle (initiate / status / execute / cancel) with 5-day timelock decode
 *
 * Network calls go through viem PublicClient + WalletClient. Caller injects the WalletClient
 * (from KeypairSpaceRouterSigner / OWSWallet) so this class doesn't own a key.
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, getContract,
  type Hex, type Address, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig } from '../types.js';
import { NPaymentError } from '../errors.js';

// ─── ABIs (minimal, only what we call) ──────────────────────────────────────

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

/**
 * TokenPaymentEscrow — minimal surface used by the SDK.
 * Function signatures derived from the public Creditcoin Blockscout source for
 * 0xC130F5D76f0b4Ce8FE2ceA0D2C2b8f53A39a5cd0 (mainnet v1.5).
 */
export const ESCROW_ABI = parseAbi([
  'function deposit(uint256 amount)',
  'function balanceOf(address consumer) view returns (uint256)',
  'function maxRatePerGB() view returns (uint256)',
  'function initiateWithdrawal(uint256 amount)',
  'function executeWithdrawal()',
  'function cancelWithdrawal()',
  'function withdrawalRequests(address consumer) view returns (uint256 amount, uint64 unlockAtEpochSeconds)',
]);

// ─── Errors ─────────────────────────────────────────────────────────────────

export class EscrowEmptyError extends NPaymentError {
  constructor(have: bigint, need: bigint) {
    super(`Escrow balance too low: have ${have}, need ${need}`, 'SR_ESCROW_EMPTY',
      'Run client.deposit(amount) or enable autoEscrow.');
  }
}
export class WithdrawalLockedError extends NPaymentError {
  constructor(unlockAt: bigint) {
    super(`Withdrawal locked until epoch ${unlockAt}`, 'SR_WITHDRAW_LOCKED',
      'Wait 5 days from initiateWithdrawal, or cancelWithdrawal.');
  }
}
export class WithdrawalAlreadyPendingError extends NPaymentError {
  constructor() { super('Withdrawal already pending', 'SR_WITHDRAW_PENDING',
    'Cancel the pending withdrawal before initiating a new one.'); }
}

// ─── Config + status types ──────────────────────────────────────────────────

export interface EscrowClientConfig {
  chain: ChainConfig;
  /** TokenPaymentEscrow contract address. */
  escrowAddress: Address;
  /** SPACE/SPC token address. */
  tokenAddress: Address;
  /** Private key for sending state-changing transactions. Required for deposit/withdraw. */
  privateKey?: Hex;
  /** Optional pre-built clients (for tests). */
  publicClient?: PublicClient;
  walletClient?: WalletClient;
}

export interface WithdrawalRequest {
  amount: bigint;
  unlockAtEpochSeconds: bigint;
  /** True when 5-day timelock has elapsed. */
  unlocked: boolean;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class SpaceRouterEscrowClient {
  private readonly publicClient: PublicClient;
  private readonly walletClient?: WalletClient;
  private readonly escrowAddress: Address;
  private readonly tokenAddress: Address;
  private readonly account?: Address;

  constructor(config: EscrowClientConfig) {
    this.escrowAddress = config.escrowAddress;
    this.tokenAddress = config.tokenAddress;

    this.publicClient = config.publicClient ?? createPublicClient({
      transport: http(config.chain.rpcUrl),
    });

    if (config.walletClient) {
      this.walletClient = config.walletClient;
      this.account = config.walletClient.account?.address;
    } else if (config.privateKey) {
      const account = privateKeyToAccount(config.privateKey);
      this.account = account.address;
      this.walletClient = createWalletClient({
        account,
        transport: http(config.chain.rpcUrl),
      });
    }
  }

  /** Read-only: escrow SPACE balance for `consumer`. */
  async getBalance(consumer: Address): Promise<bigint> {
    const escrow = getContract({ address: this.escrowAddress, abi: ESCROW_ABI, client: this.publicClient });
    return escrow.read.balanceOf([consumer]);
  }

  /** Read-only: gateway-published max rate per GB (wei). */
  async getMaxRatePerGB(): Promise<bigint> {
    const escrow = getContract({ address: this.escrowAddress, abi: ESCROW_ABI, client: this.publicClient });
    return escrow.read.maxRatePerGB();
  }

  /**
   * Deposit `amount` (in wei). Two transactions: ERC-20 approve (skipped if allowance ≥ amount),
   * then escrow.deposit. Returns the deposit tx hash.
   */
  async deposit(amount: bigint): Promise<Hex> {
    this.requireWriter();
    const owner = this.account!;
    const allowance = await this.publicClient.readContract({
      address: this.tokenAddress, abi: ERC20_ABI, functionName: 'allowance', args: [owner, this.escrowAddress],
    });
    if (allowance < amount) {
      const approveHash = await this.walletClient!.writeContract({
        address: this.tokenAddress, abi: ERC20_ABI, functionName: 'approve',
        args: [this.escrowAddress, amount],
        // viem requires chain when account is hoisted via createWalletClient; passing undefined uses tx-level fallback
        chain: null, account: this.account!,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
    return this.walletClient!.writeContract({
      address: this.escrowAddress, abi: ESCROW_ABI, functionName: 'deposit', args: [amount],
      chain: null, account: this.account!,
    });
  }

  /** Initiate a 5-day-locked withdrawal of `amount` wei. Throws if a request is already pending. */
  async initiateWithdrawal(amount: bigint): Promise<Hex> {
    this.requireWriter();
    const existing = await this.getWithdrawalRequest(this.account!);
    if (existing.amount > 0n) throw new WithdrawalAlreadyPendingError();
    return this.walletClient!.writeContract({
      address: this.escrowAddress, abi: ESCROW_ABI, functionName: 'initiateWithdrawal', args: [amount],
      chain: null, account: this.account!,
    });
  }

  /** Read pending withdrawal status. Returns zero amount when none pending. */
  async getWithdrawalRequest(consumer: Address): Promise<WithdrawalRequest> {
    const [amount, unlockAtEpochSeconds] = await this.publicClient.readContract({
      address: this.escrowAddress, abi: ESCROW_ABI, functionName: 'withdrawalRequests', args: [consumer],
    }) as [bigint, bigint];
    return {
      amount,
      unlockAtEpochSeconds,
      unlocked: amount > 0n && BigInt(Math.floor(Date.now() / 1000)) >= unlockAtEpochSeconds,
    };
  }

  /** Execute a previously-initiated withdrawal. Throws if still locked. */
  async executeWithdrawal(): Promise<Hex> {
    this.requireWriter();
    const req = await this.getWithdrawalRequest(this.account!);
    if (!req.unlocked) throw new WithdrawalLockedError(req.unlockAtEpochSeconds);
    return this.walletClient!.writeContract({
      address: this.escrowAddress, abi: ESCROW_ABI, functionName: 'executeWithdrawal',
      chain: null, account: this.account!,
    });
  }

  /** Cancel a pending withdrawal. */
  async cancelWithdrawal(): Promise<Hex> {
    this.requireWriter();
    return this.walletClient!.writeContract({
      address: this.escrowAddress, abi: ESCROW_ABI, functionName: 'cancelWithdrawal',
      chain: null, account: this.account!,
    });
  }

  private requireWriter(): void {
    if (!this.walletClient || !this.account) {
      throw new NPaymentError('Escrow write requires a privateKey or walletClient', 'SR_ESCROW_NO_WRITER',
        'Pass spacerouter.privateKey or instantiate the escrow client with a walletClient.');
    }
  }
}
