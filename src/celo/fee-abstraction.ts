/**
 * v0.25 — Celo CIP-64 fee abstraction transactor.
 *
 * The single new transactor primitive in v0.25. Wraps viem's `writeContract`
 * + `sendTransaction` with a `feeCurrency` field so gas is paid in USDC /
 * USDT / USDm instead of CELO. The agent never holds CELO. The `feeCurrency`
 * value is the on-chain fee-currency *adapter* address registered in Celo's
 * FeeCurrencyDirectory — NOT the raw ERC-20 address (except for legacy
 * Mento stables like USDm/cUSD which are themselves CIP-66-compliant).
 *
 * SOLID — Single Responsibility:
 *   1. Resolve the correct adapter address for the chosen pay-asset.
 *   2. Inject `feeCurrency` into any viem write call.
 *   3. Settle EIP-3009 `transferWithAuthorization` (the merchant-side x402 path).
 *
 * Gas-rate estimation is intentionally NOT here — viem's Celo formatters
 * already populate `maxFeePerGas` against the chosen `feeCurrency` adapter
 * via the `eth_gasPrice` RPC endpoint. Adding our own oracle would duplicate
 * viem's behavior. Callers that want a USD-denominated quote pre-tx should
 * call `publicClient.estimateGas({ ..., feeCurrency })` directly.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, celoSepolia } from 'viem/chains';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';

export type CeloChainKey = 'celo-mainnet' | 'celo-sepolia';
export type CeloPayAsset = 'USDC' | 'USDT' | 'USDm';

/** Minimal EIP-3009 ABI fragment for transferWithAuthorization settlement. */
export const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from',        type: 'address' },
      { name: 'to',          type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'validAfter',  type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce',       type: 'bytes32' },
      { name: 'v',           type: 'uint8'   },
      { name: 'r',           type: 'bytes32' },
      { name: 's',           type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export interface CeloFeeAbstractedTransactorOptions {
  /** Override the resolved fee-currency adapter address. */
  adapterOverride?: Address;
  /** Soft-disable CIP-64; transactor falls back to standard EIP-1559 (CELO gas). */
  disabled?: boolean;
  /** Override RPC URL (defaults to chains.ts entry). */
  rpcUrl?: string;
}

/**
 * Wraps a viem WalletClient on Celo (mainnet or sepolia) so every on-chain
 * write call automatically carries a `feeCurrency` field — paying gas in
 * the agent's payment asset (USDC / USDT / USDm).
 */
export class CeloFeeAbstractedTransactor {
  private readonly publicClient: { waitForTransactionReceipt: (args: { hash: Hex }) => Promise<{ blockNumber: bigint }> };
  private readonly walletClient: { writeContract: (args: Record<string, unknown>) => Promise<Hex> };
  private readonly account: ReturnType<typeof privateKeyToAccount>;
  private readonly chainKey: CeloChainKey;
  private readonly payAsset: CeloPayAsset;
  private readonly adapterOverride?: Address;
  private readonly disabled: boolean;

  constructor(
    privateKey: Hex,
    chainKey: CeloChainKey,
    payAsset: CeloPayAsset = 'USDC',
    opts: CeloFeeAbstractedTransactorOptions = {},
  ) {
    this.chainKey = chainKey;
    this.payAsset = payAsset;
    this.adapterOverride = opts.adapterOverride;
    this.disabled = opts.disabled ?? false;

    const chain = chainKey === 'celo-mainnet' ? celo : celoSepolia;
    const rpcUrl = opts.rpcUrl ?? CHAINS[chainKey].rpcUrl;
    this.account = privateKeyToAccount(privateKey);
    // Cast away the celo-specific formatter type-mismatch with the generic
    // PublicClient/WalletClient — celo chains carry custom block formatters
    // that conflict with TS's structural inference. Runtime behavior is
    // identical; only the type surface changes.
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as never;
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) }) as never;
  }

  /**
   * Resolve the CIP-64 fee-currency address for the chosen pay-asset.
   * Returns `undefined` when fee abstraction is disabled — caller should
   * omit `feeCurrency` and let viem fall back to native CELO gas.
   */
  getFeeCurrency(): Address | undefined {
    if (this.disabled) return undefined;
    if (this.adapterOverride) return this.adapterOverride;
    const tokens = CHAINS[this.chainKey].tokens;
    if (this.payAsset === 'USDC') {
      const a = tokens.USDC_FEE_ADAPTER as Address | undefined;
      if (!a) throw rejected(`No USDC_FEE_ADAPTER registered on ${this.chainKey}`);
      return a;
    }
    if (this.payAsset === 'USDT') {
      const a = tokens.USDT_FEE_ADAPTER as Address | undefined;
      if (!a) throw rejected(`No USDT_FEE_ADAPTER registered on ${this.chainKey} — only mainnet supported in v0.25`);
      return a;
    }
    if (this.payAsset === 'USDm') {
      // USDm (legacy cUSD) is itself a CIP-66 fee currency — use the token
      // address directly, no separate adapter exists.
      const a = tokens.USDm as Address | undefined;
      if (!a) throw rejected(`No USDm registered on ${this.chainKey}`);
      return a;
    }
    throw new NPaymentError(
      `Unsupported payAsset for Celo fee abstraction: ${String(this.payAsset)}`,
      'INVALID_PAY_ASSET',
      'Use one of: USDC, USDT, USDm.',
    );
  }

  /** Public client for view calls (balance reads, gas estimates). */
  getPublicClient(): unknown {
    return this.publicClient;
  }

  /** Underlying account (signer address). */
  getAddress(): Address {
    return this.account.address;
  }

  /**
   * Generic CIP-64-wrapped writeContract. Caller passes standard viem
   * write params; we inject `feeCurrency` and broadcast. Returns the
   * tx hash + receipt block number.
   */
  async writeContract(params: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const feeCurrency = this.getFeeCurrency();
    const txHash = await this.walletClient.writeContract({
      ...params,
      ...(feeCurrency ? { feeCurrency } : {}),
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: receipt.blockNumber };
  }

  /**
   * Settle an EIP-3009 transferWithAuthorization on a Celo USDC/USDT/USDm
   * contract — the merchant-side x402 settlement path. The facilitator
   * wallet (this transactor's signer) pays gas in the same pay-asset.
   */
  async transferWithAuthorization(params: {
    token: Address;
    from: Address;
    to: Address;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: Hex;
    signature: Hex;
  }): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const sig = parseSignature(params.signature);
    return this.writeContract({
      address: params.token,
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: 'transferWithAuthorization',
      args: [
        params.from,
        params.to,
        params.value,
        params.validAfter,
        params.validBefore,
        params.nonce,
        Number(sig.v ?? 27),
        sig.r,
        sig.s,
      ],
    });
  }
}

function rejected(msg: string): NPaymentError {
  return new NPaymentError(
    msg,
    'CELO_FEE_ABSTRACTION_REJECTED',
    'Configure CHAINS[...].tokens.{USDC,USDT}_FEE_ADAPTER or pass celo.feeCurrencyAdapterOverride.',
  );
}
