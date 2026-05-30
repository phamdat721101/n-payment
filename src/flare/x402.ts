/**
 * Flare x402 — buyer adapter, merchant settle helper, deploy helper (v0.19).
 *
 * Three exports, one cohesive module:
 *
 *   • FlareX402Adapter             — buyer-side. Implements PaymentAdapter.
 *                                     Signs EIP-3009 transferWithAuthorization
 *                                     against MockUSDT0 (or any EIP-3009 token)
 *                                     and posts Flare's flat 9-field X-Payment
 *                                     header. Reuses src/morph/eip3009.ts for
 *                                     all EIP-712 plumbing — zero duplication.
 *
 *   • verifyAndSettleFlareX402(…)  — merchant-side. Reads X402Facilitator
 *                                     .verifyPayment, then writes settlePayment
 *                                     and waits for the receipt. Pure function;
 *                                     consumers wire it into createPaywall.
 *
 *   • deployFlareX402Contracts(…)  — one-shot viem deploy of MockUSDT0 +
 *                                     X402Facilitator from caller-supplied
 *                                     compiled artifacts. No solc dep.
 *
 * Design (SOLID):
 *   - SRP: each export does one thing.
 *   - OCP: domain `name`/`version` are constructor parameters. The day FXRP
 *          ships EIP-3009, instantiate with `tokenName: 'FXRP'` instead of
 *          editing this file.
 *   - DIP: adapter takes OWSWallet (interface), helper takes viem clients
 *          (interfaces), deploy takes artifacts (structural type).
 */
import type { Abi, Address, Hex, PublicClient, WalletClient } from 'viem';
import type { OWSWallet } from '../ows/wallet.js';
import type { PaymentAdapter, ChainKey } from '../types.js';
import { CHAINS } from '../chains.js';
import {
  ChallengeParseError,
  InsufficientBalanceError,
  NPaymentError,
} from '../errors.js';
import {
  buildTransferWithAuthorizationTypedData,
  randomEip3009Nonce,
  splitSignature,
} from '../morph/eip3009.js';

// ─── Public types ────────────────────────────────────────────────────────────

/** Flare x402 payment payload — flat 9-field shape with split signature (per Flare docs). */
export interface FlareX402Payload {
  from: Address;
  to: Address;
  token: Address;
  value: string;        // base-10 string (uint256)
  validAfter: string;   // base-10 string
  validBefore: string;  // base-10 string
  nonce: Hex;           // 0x + 64 hex
  v: number;
  r: Hex;
  s: Hex;
}

export interface VerifyAndSettleParams {
  publicClient: PublicClient;
  walletClient: WalletClient;
  facilitatorAddress: Address;
  payload: FlareX402Payload;
  /** Override receipt poll timeout (ms). @default 60_000 */
  receiptTimeoutMs?: number;
}

export interface VerifyAndSettleResult {
  paymentId: Hex;
  transactionHash: Hex;
  settled: true;
}

export interface ContractArtifact {
  abi: Abi;
  bytecode: Hex;
}

export interface DeployFlareX402Params {
  walletClient: WalletClient;
  publicClient: PublicClient;
  /** Deployer/owner address (also used as feeRecipient on X402Facilitator). */
  deployer: Address;
  artifacts: { mockUsdt0: ContractArtifact; x402Facilitator: ContractArtifact };
  /** Fee in basis points for the facilitator. @default 0 */
  feeBps?: number;
}

export interface DeployFlareX402Result {
  mockUsdt0Address: Address;
  x402FacilitatorAddress: Address;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** EIP-712 domain defaults for MockUSDT0 — match Flare's published demo. */
const DEFAULT_TOKEN_NAME = 'Mock USDT0';
const DEFAULT_TOKEN_VERSION = '1';
const DEFAULT_VALIDITY_SECONDS = 300;

/**
 * Per-chain mapping from `network` strings Flare emits in 402 envelopes
 * back to our internal ChainKey. Flare uses non-CAIP-2 strings; we accept
 * both forms for forward compatibility with future facilitator deployments.
 */
const FLARE_NETWORK_ALIASES: Readonly<Record<string, ChainKey>> = Object.freeze({
  'flare-coston2': 'flare-coston2-testnet',
  'flare-songbird': 'flare-songbird-mainnet',
  'flare': 'flare-mainnet',
  'eip155:114': 'flare-coston2-testnet',
  'eip155:19': 'flare-songbird-mainnet',
  'eip155:14': 'flare-mainnet',
});

/**
 * Minimal X402Facilitator ABI — only the two functions the adapter + merchant
 * helper call. Pulled from Flare's published demo.
 */
const X402_FACILITATOR_ABI = [
  {
    type: 'function',
    name: 'verifyPayment',
    stateMutability: 'view',
    inputs: [
      {
        name: 'payment',
        type: 'tuple',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [
      { name: 'paymentId', type: 'bytes32' },
      { name: 'valid', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'settlePayment',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'payment',
        type: 'tuple',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'addSupportedToken',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [],
  },
] as const satisfies Abi;

// ─── Buyer adapter ───────────────────────────────────────────────────────────

/**
 * Internal: parsed shape of a Flare 402 challenge. Tolerant of both header-style
 * (base64-encoded JSON in `payment-required`) and Flare-reference body-style
 * (status 402 + JSON body) envelopes.
 */
interface ParsedFlareChallenge {
  scheme: string;
  network: string;
  payTo: Address;
  asset: Address;
  amount: bigint;
  facilitatorAddress?: Address;
  chainId?: number;
}

export class FlareX402Adapter implements PaymentAdapter {
  readonly protocol = 'flare-x402';

  constructor(
    private readonly wallet: OWSWallet,
    private readonly chainKey: ChainKey,
    private readonly options: {
      tokenName?: string;
      tokenVersion?: string;
      validityWindowSeconds?: number;
    } = {},
  ) {}

  detect(response: Response): boolean {
    if (response.status !== 402) return false;
    const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (!header) {
      // Flare reference servers put the challenge in the body; defer to pay() to read it.
      // We only claim the response when we are the configured chain's adapter.
      return true;
    }
    try {
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString());
      const network = decoded?.accepts?.[0]?.network as string | undefined;
      if (!network) return false;
      const mapped = FLARE_NETWORK_ALIASES[network];
      return mapped === this.chainKey || network === CHAINS[this.chainKey].caip2;
    } catch {
      return false;
    }
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const challenge = await this.readChallenge(response);
    const chain = CHAINS[this.chainKey];

    // Pre-flight balance check — avoid signing a dead-on-arrival authorization.
    const account = this.wallet.getAccount();
    if (!account) {
      throw new NPaymentError(
        'FlareX402Adapter requires ows.privateKey for EIP-3009 typed-data signing',
        'FLARE_X402_NO_SIGNER',
        'Pass ows: { privateKey: "0x..." }; OWS-driver native EIP-712 path lands in v0.20.',
      );
    }
    const balance = await this.wallet.getBalance(challenge.asset, chain.chainId);
    if (balance < challenge.amount) {
      throw new InsufficientBalanceError(
        `Insufficient ${challenge.asset} on ${chain.name}: have ${balance}, need ${challenge.amount}`,
        'INSUFFICIENT_BALANCE',
        `Fund wallet on ${chain.name} (chainId ${chain.chainId}); MockUSDT0 has a public mint() for testnet.`,
      );
    }

    const validAfter = 0n;
    const validBefore = BigInt(
      Math.floor(Date.now() / 1000) +
        (this.options.validityWindowSeconds ?? DEFAULT_VALIDITY_SECONDS),
    );
    const nonce = randomEip3009Nonce();
    const authorization = {
      from: account.address,
      to: challenge.payTo,
      value: challenge.amount,
      validAfter,
      validBefore,
      nonce,
    };

    const td = buildTransferWithAuthorizationTypedData({
      verifyingContract: challenge.asset,
      chainId: challenge.chainId ?? chain.chainId,
      tokenName: this.options.tokenName ?? DEFAULT_TOKEN_NAME,
      tokenVersion: this.options.tokenVersion ?? DEFAULT_TOKEN_VERSION,
      authorization,
    });
    const signature = await account.signTypedData({
      domain: td.domain,
      types: td.types,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    });
    const { v, r, s } = splitSignature(signature);

    const payload: FlareX402Payload = {
      from: account.address,
      to: challenge.payTo,
      token: challenge.asset,
      value: challenge.amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
      v,
      r,
      s,
    };

    const xPaymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment', xPaymentHeader);
    return fetch(url, { ...init, headers: retryHeaders });
  }

  /** Read challenge from header (preferred) or fall back to JSON body (Flare reference shape). */
  private async readChallenge(response: Response): Promise<ParsedFlareChallenge> {
    const headerStr = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
    if (headerStr) {
      try {
        const decoded = JSON.parse(Buffer.from(headerStr, 'base64').toString());
        return parseAccepts(decoded);
      } catch (err) {
        throw new ChallengeParseError(
          `Malformed Flare payment-required header: ${(err as Error).message}`,
          'FLARE_X402_BAD_HEADER',
        );
      }
    }
    // Body-style fallback (clone so the original response can still be consumed by callers).
    try {
      const body = await response.clone().json();
      return parseAccepts(body);
    } catch (err) {
      throw new ChallengeParseError(
        `Flare 402 response had neither payment-required header nor JSON body with accepts[]: ${(err as Error).message}`,
        'FLARE_X402_NO_CHALLENGE',
      );
    }
  }
}

function parseAccepts(decoded: unknown): ParsedFlareChallenge {
  const accept = (decoded as { accepts?: Array<Record<string, unknown>> })?.accepts?.[0];
  if (!accept) {
    throw new ChallengeParseError('No accepts[0] entry in Flare 402 envelope', 'FLARE_X402_NO_ACCEPTS');
  }
  const extra = (accept.extra ?? {}) as Record<string, unknown>;
  const asset = (extra.tokenAddress ?? accept.asset) as Address | undefined;
  const payTo = accept.payTo as Address | undefined;
  if (!asset) throw new ChallengeParseError('Flare 402 missing asset/extra.tokenAddress', 'FLARE_X402_NO_ASSET');
  if (!payTo) throw new ChallengeParseError('Flare 402 missing payTo', 'FLARE_X402_NO_PAY_TO');
  const amount = BigInt(String(accept.maxAmountRequired ?? '0'));
  if (amount === 0n) throw new ChallengeParseError('Flare 402 zero maxAmountRequired', 'FLARE_X402_ZERO_AMOUNT');
  return {
    scheme: String(accept.scheme ?? 'exact'),
    network: String(accept.network ?? ''),
    payTo,
    asset,
    amount,
    facilitatorAddress: extra.facilitatorAddress as Address | undefined,
    chainId: extra.chainId as number | undefined,
  };
}

// ─── Merchant settle helper ──────────────────────────────────────────────────

/**
 * Verify + settle a Flare x402 payment via the on-chain X402Facilitator.
 * Pure function; the merchant middleware in `src/middleware.ts` calls it after
 * decoding the buyer's X-Payment header.
 *
 * Throws structured errors:
 *   - FLARE_X402_VERIFY_FAILED — facilitator's verifyPayment returned valid=false
 *   - FLARE_X402_SETTLE_FAILED — settle reverted or receipt status != 'success'
 */
export async function verifyAndSettleFlareX402(
  params: VerifyAndSettleParams,
): Promise<VerifyAndSettleResult> {
  const { publicClient, walletClient, facilitatorAddress, payload } = params;
  const tuple = payloadToTuple(payload);

  const verified = (await publicClient.readContract({
    address: facilitatorAddress,
    abi: X402_FACILITATOR_ABI,
    functionName: 'verifyPayment',
    args: [tuple],
  })) as readonly [Hex, boolean];
  const [paymentId, valid] = verified;
  if (!valid) {
    throw new NPaymentError(
      `X402Facilitator.verifyPayment returned invalid for paymentId=${paymentId}`,
      'FLARE_X402_VERIFY_FAILED',
      'Most common causes: nonce already consumed, signature does not recover to from, or validBefore expired.',
    );
  }

  const txHash = (await walletClient.writeContract({
    address: facilitatorAddress,
    abi: X402_FACILITATOR_ABI,
    functionName: 'settlePayment',
    args: [tuple],
    account: walletClient.account ?? null,
    chain: walletClient.chain ?? null,
  } as never)) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: params.receiptTimeoutMs ?? 60_000,
  });
  if (receipt.status !== 'success') {
    throw new NPaymentError(
      `X402Facilitator.settlePayment tx ${txHash} reverted`,
      'FLARE_X402_SETTLE_FAILED',
      'Inspect the transaction on the Flare/Coston2 explorer; common cause is buyer balance changing between verify and settle.',
    );
  }

  return { paymentId, transactionHash: txHash, settled: true };
}

function payloadToTuple(p: FlareX402Payload) {
  return {
    from: p.from,
    to: p.to,
    token: p.token,
    value: BigInt(p.value),
    validAfter: BigInt(p.validAfter),
    validBefore: BigInt(p.validBefore),
    nonce: p.nonce,
    v: p.v,
    r: p.r,
    s: p.s,
  };
}

/** Decode an X-Payment header (base64 JSON) into the typed payload. Used by middleware. */
export function decodeFlareX402Header(headerValue: string): FlareX402Payload {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(headerValue, 'base64').toString());
  } catch (err) {
    throw new ChallengeParseError(
      `Malformed X-Payment header: ${(err as Error).message}`,
      'FLARE_X402_BAD_X_PAYMENT',
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const k of ['from', 'to', 'token', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof obj[k] !== 'string') {
      throw new ChallengeParseError(`X-Payment missing/invalid field: ${k}`, 'FLARE_X402_BAD_X_PAYMENT');
    }
  }
  if (typeof obj.v !== 'number') {
    throw new ChallengeParseError('X-Payment missing/invalid field: v', 'FLARE_X402_BAD_X_PAYMENT');
  }
  return {
    from: obj.from as Address,
    to: obj.to as Address,
    token: obj.token as Address,
    value: obj.value as string,
    validAfter: obj.validAfter as string,
    validBefore: obj.validBefore as string,
    nonce: obj.nonce as Hex,
    v: obj.v as number,
    r: obj.r as Hex,
    s: obj.s as Hex,
  };
}

// ─── Deploy helper ───────────────────────────────────────────────────────────

/**
 * Deploy MockUSDT0 + X402Facilitator on the connected Flare network and wire
 * MockUSDT0 as a supported token. Caller supplies compiled artifacts (typically
 * imported from a Hardhat build of Flare's official demo contracts) so the SDK
 * has no Solidity-compiler dependency.
 *
 * Source contracts:
 *   https://github.com/flare-foundation/flare-hardhat-starter (scripts/x402)
 */
export async function deployFlareX402Contracts(
  params: DeployFlareX402Params,
): Promise<DeployFlareX402Result> {
  const { walletClient, publicClient, deployer, artifacts } = params;
  const feeBps = params.feeBps ?? 0;

  const mockUsdt0Hash = await walletClient.deployContract({
    abi: artifacts.mockUsdt0.abi,
    bytecode: artifacts.mockUsdt0.bytecode,
    account: walletClient.account ?? null,
    chain: walletClient.chain ?? null,
  } as never);
  const mockUsdt0Receipt = await publicClient.waitForTransactionReceipt({ hash: mockUsdt0Hash });
  if (!mockUsdt0Receipt.contractAddress) {
    throw new NPaymentError('MockUSDT0 deploy receipt has no contractAddress', 'FLARE_X402_DEPLOY_FAILED');
  }
  const mockUsdt0Address = mockUsdt0Receipt.contractAddress as Address;

  const x402Hash = await walletClient.deployContract({
    abi: artifacts.x402Facilitator.abi,
    bytecode: artifacts.x402Facilitator.bytecode,
    args: [deployer, BigInt(feeBps)],
    account: walletClient.account ?? null,
    chain: walletClient.chain ?? null,
  } as never);
  const x402Receipt = await publicClient.waitForTransactionReceipt({ hash: x402Hash });
  if (!x402Receipt.contractAddress) {
    throw new NPaymentError('X402Facilitator deploy receipt has no contractAddress', 'FLARE_X402_DEPLOY_FAILED');
  }
  const x402FacilitatorAddress = x402Receipt.contractAddress as Address;

  // Register MockUSDT0 as supported on the facilitator.
  const addTokenHash = await walletClient.writeContract({
    address: x402FacilitatorAddress,
    abi: X402_FACILITATOR_ABI,
    functionName: 'addSupportedToken',
    args: [mockUsdt0Address],
    account: walletClient.account ?? null,
    chain: walletClient.chain ?? null,
  } as never);
  await publicClient.waitForTransactionReceipt({ hash: addTokenHash });

  return { mockUsdt0Address, x402FacilitatorAddress };
}

// ─── Middleware integration helper ───────────────────────────────────────────

/**
 * Build a Flare-style 402 challenge body (as base64 for `payment-required`
 * header — keeps wire-format compatible with the rest of the SDK while still
 * matching what FlareX402Adapter.detect() expects).
 */
export function buildFlareX402Challenge(input: {
  price: string;
  payTo: Address;
  asset: Address;
  facilitatorAddress: Address;
  network?: string;
  chainId?: number;
  resource?: string;
  description?: string;
}): string {
  const challenge = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: input.network ?? 'flare-coston2',
        maxAmountRequired: input.price,
        resource: input.resource ?? '',
        description: input.description ?? '',
        mimeType: 'application/json',
        payTo: input.payTo,
        maxTimeoutSeconds: 300,
        asset: input.asset,
        extra: {
          tokenAddress: input.asset,
          facilitatorAddress: input.facilitatorAddress,
          chainId: input.chainId ?? 114,
        },
      },
    ],
  };
  return Buffer.from(JSON.stringify(challenge)).toString('base64');
}

export { X402_FACILITATOR_ABI };
