/**
 * v0.25 — Mento Broker viem-backed client.
 *
 * Pulls live quotes from Mento's on-chain Broker contract (address resolved
 * via CHAINS table or constructor override). The `swapIn` write call is
 * routed through `CeloFeeAbstractedTransactor` so the swap itself is
 * fee-abstracted — the agent pays gas in the asset it's swapping FROM, not
 * CELO.
 *
 * SOLID — Single Responsibility: this client is the on-chain I/O boundary
 * for Mento. Path selection lives in `mento.ts` (pure function, mockable).
 */
import type { Address, Hex } from 'viem';
import { createPublicClient, http } from 'viem';
import { celo, celoSepolia } from 'viem/chains';
import { CHAINS } from '../chains.js';
import { NPaymentError } from '../errors.js';
import type { CeloFeeAbstractedTransactor } from './fee-abstraction.js';

type CeloChainKey = 'celo-mainnet' | 'celo-sepolia';

/** Minimal Mento Broker ABI — getAmountOut + swapIn. */
const MENTO_BROKER_ABI = [
  {
    name: 'getAmountOut',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'exchangeProvider', type: 'address' },
      { name: 'exchangeId',       type: 'bytes32' },
      { name: 'tokenIn',          type: 'address' },
      { name: 'tokenOut',         type: 'address' },
      { name: 'amountIn',         type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    name: 'swapIn',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'exchangeProvider', type: 'address' },
      { name: 'exchangeId',       type: 'bytes32' },
      { name: 'tokenIn',          type: 'address' },
      { name: 'tokenOut',         type: 'address' },
      { name: 'amountIn',         type: 'uint256' },
      { name: 'amountOutMin',     type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface MentoBrokerClientOptions {
  /** Override Mento Broker address (default: CHAINS[chainKey].tokens.MENTO_BROKER). */
  brokerOverride?: Address;
  /**
   * Exchange provider + exchangeId resolution strategy. v0.25 ships a
   * caller-supplied tuple per pair — production integrators read these from
   * Mento's BiPoolManager (`getExchangeIds`) and inject them at construction.
   * Mock implementations can return any value.
   */
  resolveExchange: (tokenIn: Address, tokenOut: Address) => { provider: Address; exchangeId: Hex };
  /** Override RPC URL. */
  rpcUrl?: string;
}

export class MentoBrokerClient {
  private readonly publicClient: { readContract: (args: Record<string, unknown>) => Promise<unknown> };
  private readonly broker: Address;
  private readonly resolveExchange: MentoBrokerClientOptions['resolveExchange'];
  private readonly chainKey: CeloChainKey;

  constructor(chainKey: CeloChainKey, opts: MentoBrokerClientOptions) {
    this.chainKey = chainKey;
    const broker = opts.brokerOverride ?? (CHAINS[chainKey].tokens.MENTO_BROKER as Address | undefined);
    if (!broker) {
      throw new NPaymentError(
        `Mento broker address not registered on ${chainKey}`,
        'CELO_MENTO_BROKER_MISSING',
        'Pass MentoBrokerClientOptions.brokerOverride or extend chains.ts.',
      );
    }
    this.broker = broker;
    this.resolveExchange = opts.resolveExchange;
    const chain = chainKey === 'celo-mainnet' ? celo : celoSepolia;
    const rpcUrl = opts.rpcUrl ?? CHAINS[chainKey].rpcUrl;
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as never;
  }

  /** Read-only quote for `tokenIn → tokenOut`. Returns 0n if pool doesn't exist. */
  async getAmountOut(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint> {
    const { provider, exchangeId } = this.resolveExchange(tokenIn, tokenOut);
    const out = await this.publicClient.readContract({
      address: this.broker,
      abi: MENTO_BROKER_ABI,
      functionName: 'getAmountOut',
      args: [provider, exchangeId, tokenIn, tokenOut, amountIn],
    });
    return out as bigint;
  }

  /**
   * Execute a Mento swap with CIP-64 fee abstraction. The transactor MUST be
   * pre-funded in `tokenIn` AND must hold an ERC-20 allowance ≥ `amountIn`
   * to the broker (the SDK does NOT auto-approve — caller's responsibility).
   */
  async swapIn(
    transactor: CeloFeeAbstractedTransactor,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    amountOutMin: bigint,
  ): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const { provider, exchangeId } = this.resolveExchange(tokenIn, tokenOut);
    return transactor.writeContract({
      address: this.broker,
      abi: MENTO_BROKER_ABI,
      functionName: 'swapIn',
      args: [provider, exchangeId, tokenIn, tokenOut, amountIn, amountOutMin],
    });
  }

  getBrokerAddress(): Address {
    return this.broker;
  }

  getChainKey(): CeloChainKey {
    return this.chainKey;
  }
}
