import type { Hex, Address } from 'viem';
import type { OWSWallet } from '../ows/wallet.js';

export const GOAT_IDENTITY_REGISTRY: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const GOAT_REPUTATION_REGISTRY: Address = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

const IDENTITY_ABI = [
  {
    name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const REPUTATION_ABI = [
  {
    name: 'giveFeedback', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' }, { name: 'value', type: 'int256' },
      { name: 'valueDecimals', type: 'uint8' }, { name: 'tag1', type: 'bytes32' },
      { name: 'tag2', type: 'bytes32' }, { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' }, { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'getSummary', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' }, { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'bytes32' }, { name: 'tag2', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'count', type: 'uint256' }, { name: 'sum', type: 'int256' },
    ]}],
  },
] as const;

/**
 * ERC-8004 agent identity + reputation on GOAT Network.
 * Uses OWSWallet for signing — no private key exposure.
 */
export class GoatIdentity {
  private wallet: OWSWallet;
  private rpcUrl: string;
  private chainId: number;

  constructor(wallet: OWSWallet, rpcUrl = 'https://rpc.goat.network', chainId = 2345) {
    this.wallet = wallet;
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
  }

  async registerAgent(agentURI: string): Promise<Hex> {
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [agentURI] });
    const result = await this.wallet.signTransaction({ to: GOAT_IDENTITY_REGISTRY, data }, this.chainId);
    return result.txHash as Hex;
  }

  async giveFeedback(agentId: bigint, value: number, endpoint: string): Promise<Hex> {
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({
      abi: REPUTATION_ABI, functionName: 'giveFeedback',
      args: [agentId, BigInt(value), 2, ZERO_BYTES32, ZERO_BYTES32, endpoint, '', ZERO_BYTES32],
    });
    const result = await this.wallet.signTransaction({ to: GOAT_REPUTATION_REGISTRY, data }, this.chainId);
    return result.txHash as Hex;
  }

  async getSummary(agentId: bigint): Promise<{ count: bigint; sum: bigint }> {
    const { createPublicClient, http } = await import('viem');
    const client = createPublicClient({ transport: http(this.rpcUrl) });
    return client.readContract({
      address: GOAT_REPUTATION_REGISTRY, abi: REPUTATION_ABI,
      functionName: 'getSummary', args: [agentId, [], ZERO_BYTES32, ZERO_BYTES32],
    }) as any;
  }
}
