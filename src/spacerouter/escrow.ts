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
  createPublicClient, createWalletClient, formatUnits, http, parseAbi, parseUnits, getContract,
  type Hex, type Address, type PublicClient, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainConfig } from '../types.js';
import { NPaymentError } from '../errors.js';

/**
 * SPACE token decimal invariant.
 *
 * USDC = 6 decimals. SPACE = 18 decimals. Any code path that treats them the same
 * silently corrupts amounts. We pin the invariant once, here, and every helper
 * derives from this constant. This is the canonical place to change it if a future
 * SPACE deployment ever changes decimals (it shouldn't).
 *
 * @invariant SPACE_DECIMALS === 18 on creditcoin-mainnet (chainId 102030)
 */
export const SPACE_DECIMALS = 18 as const;

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
    super(
      `SpaceRouter escrow balance too low: have ${formatSpace(have)} SPACE, need ${formatSpace(need)} SPACE`,
      'SR_ESCROW_EMPTY',
      "Run client.deposit(parseSpace('1')) to top up, or fund the wallet via PenguinSwap (CTC→SPACE) first.",
    );
  }
}
export class WithdrawalLockedError extends NPaymentError {
  constructor(unlockAt: bigint) {
    const iso = new Date(Number(unlockAt) * 1000).toISOString();
    super(
      `SpaceRouter withdrawal locked until ${iso} (epoch ${unlockAt})`,
      'SR_WITHDRAW_LOCKED',
      'Wait 5 days from initiateWithdrawal, or call cancelWithdrawal() and re-initiate.',
    );
  }
}
export class WithdrawalAlreadyPendingError extends NPaymentError {
  constructor() {
    super(
      'SpaceRouter withdrawal already pending',
      'SR_WITHDRAW_PENDING',
      'Cancel the pending withdrawal (cancelWithdrawal) before initiating a new one.',
    );
  }
}
export class InvalidAmountError extends NPaymentError {
  constructor(input: unknown, reason: string) {
    super(
      `Invalid SPACE amount ${JSON.stringify(input)}: ${reason}`,
      'SR_INVALID_AMOUNT',
      "Pass a positive numeric string or number, e.g. parseSpace('1.5'). Negative or non-numeric inputs are rejected.",
    );
  }
}

// ─── 18-decimal SPACE helpers ───────────────────────────────────────────────

/**
 * Convert a human-readable SPACE amount (string or number) to wei (bigint).
 * Wraps viem's parseUnits with the canonical 18-decimal invariant + clear errors.
 *
 * @example parseSpace('1')      // 1_000000000000000000n  (1 SPACE)
 * @example parseSpace('0.5')    // 500000000000000000n    (0.5 SPACE)
 * @throws  InvalidAmountError on negative / non-numeric / non-finite input
 */
export function parseSpace(amount: string | number): bigint {
  if (amount === null || amount === undefined) throw new InvalidAmountError(amount, 'amount is null/undefined');
  const asString = typeof amount === 'number'
    ? Number.isFinite(amount) ? amount.toString() : ''
    : amount.trim();
  if (!asString) throw new InvalidAmountError(amount, 'amount is empty or non-finite');
  if (asString.startsWith('-')) throw new InvalidAmountError(amount, 'negative amounts are not allowed');
  // viem.parseUnits accepts only decimal strings; surface its error as our typed error.
  try {
    return parseUnits(asString, SPACE_DECIMALS);
  } catch (err) {
    throw new InvalidAmountError(amount, (err as Error).message);
  }
}

/**
 * Format a SPACE wei value to a human-readable decimal string, trimmed to `maxDecimals`
 * places (default 4). Trailing zeros after the decimal are removed.
 *
 * @example formatSpace(parseSpace('1.2345'), 2) // '1.23'
 * @example formatSpace(parseSpace('1'))          // '1'
 */
export function formatSpace(wei: bigint, maxDecimals = 4): string {
  const full = formatUnits(wei, SPACE_DECIMALS);
  if (!full.includes('.')) return full;
  const [int, frac] = full.split('.');
  const trimmed = frac.slice(0, Math.max(0, maxDecimals)).replace(/0+$/, '');
  return trimmed ? `${int}.${trimmed}` : int;
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
