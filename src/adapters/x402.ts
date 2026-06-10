import type { Hex, Address } from 'viem';
import type { PaymentAdapter, ChainKey } from '../types.js';
import type { OWSWallet } from '../ows/wallet.js';
import { CHAINS } from '../chains.js';
import { ChallengeParseError, InsufficientBalanceError, NPaymentError } from '../errors.js';

/**
 * Per-chain EIP-712 domain identity for native USDC contracts.
 * Hardcoded to avoid an extra `eth_call` per payment to fetch name() / version().
 * Unknown chains fall back to the canonical mainnet defaults ('USD Coin' / '2').
 */
const USDC_EIP712: Partial<Record<ChainKey, { name: string; version: string }>> = {
  'base-mainnet':     { name: 'USD Coin', version: '2' },
  'base-sepolia':     { name: 'USDC',     version: '2' },
  'arbitrum-sepolia': { name: 'USDC',     version: '2' },
  'bnb-mainnet':      { name: 'USD Coin', version: '2' },
  'bnb-testnet':      { name: 'USDC',     version: '2' },
  // v0.25 — Celo USDC = Circle FiatTokenCeloV2_2 (verified on Celoscan).
  'celo-mainnet':     { name: 'USD Coin', version: '2' },
  'celo-sepolia':     { name: 'USD Coin', version: '2' },
};

const TRANSFER_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const;

/** 32-byte cryptographic random nonce. WebCrypto: works in Node 19+, browsers, Workers, Deno. */
function randomNonce32(): Hex {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return ('0x' + Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

/**
 * x402 v2 payment adapter — spec-compliant **EIP-3009 `transferWithAuthorization`**.
 *
 * Signs an off-chain authorization (no broadcast), attaches it as the
 * `x-payment` header, and the paywall's facilitator verifies + settles
 * on-chain. This is the flow used by Base MCP, AWS Bedrock AgentCore,
 * and Coinbase's hosted facilitator.
 */
export class X402Adapter implements PaymentAdapter {
  readonly protocol = 'x402';
  private wallet: OWSWallet;
  private chainKey: ChainKey;
  /** Authorization lifetime in seconds (default 600 = 10 min). */
  private readonly validityWindowSeconds: number;

  constructor(wallet: OWSWallet, chainKey: ChainKey, validityWindowSeconds = 600) {
    this.wallet = wallet;
    this.chainKey = chainKey;
    this.validityWindowSeconds = validityWindowSeconds;
  }

  detect(response: Response): boolean {
    return response.headers.has('payment-required') || response.headers.has('x-payment-required');
  }

  async pay(url: string, init: RequestInit | undefined, response: Response): Promise<Response> {
    const chain = CHAINS[this.chainKey];

    // Parse x402 v2 PAYMENT-REQUIRED envelope
    const headerStr = response.headers.get('payment-required') ?? response.headers.get('x-payment-required') ?? '';
    if (!headerStr) throw new ChallengeParseError('Missing payment-required header', 'MISSING_HEADER');

    let challenge: any;
    try {
      challenge = JSON.parse(Buffer.from(headerStr, 'base64').toString());
    } catch {
      throw new ChallengeParseError('Malformed base64 payment-required header', 'INVALID_HEADER');
    }
    const accept = challenge.accepts?.[0];
    if (!accept) throw new ChallengeParseError('No accept entry in payment-required header', 'INVALID_HEADER');

    const payTo = accept.payTo as Address | undefined;
    const tokenAddress = (accept.asset as Address | undefined) ?? (chain.tokens.USDC as Address | undefined);
    const amount = BigInt(accept.maxAmountRequired ?? '0');

    if (!payTo)        throw new ChallengeParseError('No payTo in payment-required header', 'MISSING_PAY_TO');
    if (!tokenAddress) throw new NPaymentError('No USDC asset configured for chain', 'MISSING_ASSET');
    if (amount === 0n) throw new ChallengeParseError('Zero amount in payment-required header', 'ZERO_AMOUNT');

    // Need a viem account for typed-data signing
    const account = this.wallet.getAccount();
    if (!account) {
      throw new NPaymentError(
        'X402 EIP-3009 signing requires ows.privateKey',
        'NO_SIGNER',
        'Pass ows: { privateKey: "0x..." } or use a signing-capable OWS driver.',
      );
    }

    // Pre-flight balance — avoid signing dead-on-arrival authorizations
    const balance = await this.wallet.getBalance(tokenAddress, chain.chainId);
    if (balance < amount) {
      throw new InsufficientBalanceError(
        `Insufficient USDC: balance ${balance} < required ${amount}`,
        'INSUFFICIENT_BALANCE',
        'Fund the wallet with USDC on the target chain.',
      );
    }

    // Sign EIP-3009 transferWithAuthorization
    const validAfter = 0n;
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + this.validityWindowSeconds);
    const nonce = randomNonce32();
    const dom = USDC_EIP712[this.chainKey] ?? { name: 'USD Coin', version: '2' };

    const signature = await account.signTypedData({
      domain: {
        name: dom.name,
        version: dom.version,
        chainId: chain.chainId,
        verifyingContract: tokenAddress,
      },
      types: TRANSFER_AUTH_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: account.address,
        to: payTo,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      },
    });

    // x402 v2 envelope: { x402Version, scheme, network, payload }
    const xPayment = Buffer.from(JSON.stringify({
      x402Version: 2,
      scheme: 'exact',
      network: chain.caip2,
      payload: {
        signature,
        authorization: {
          from: account.address,
          to: payTo,
          value: amount.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    })).toString('base64');

    // Retry the original request with the signed payment header
    const retryHeaders = new Headers(init?.headers);
    retryHeaders.set('x-payment', xPayment);
    return fetch(url, { ...init, headers: retryHeaders });
  }
}
