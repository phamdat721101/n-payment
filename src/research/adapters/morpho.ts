/**
 * v0.31 — Morpho Blue protocol adapter for OnchainLendingResearchService.
 *
 * Real, live-verified integration: singleton address, market()/position()
 * ABI, and Liquidate event signature were all re-verified against Morpho's
 * official docs (docs.morpho.org/developers/contracts/blue/) and the real
 * GitHub source (morpho-org/morpho-blue) during implementation — NOT
 * copy-pasted from the original PRD-02 design doc, whose event ABI guess
 * used the wrong field name (`returnedAssets` instead of the real
 * `repaidAssets`/`repaidShares` pair) and omitted `badDebtShares` entirely.
 *
 * Uses a public, no-API-key RPC fallback (per plan requirement #4 — no
 * dedicated RPC credentials are provisioned yet). Callers may inject any
 * viem PublicClient (including one pointed at a paid provider) via the
 * constructor.
 */
import type { PublicClient } from 'viem';
import type { ProtocolAdapter, SubjectContext, PositionHealthSnapshot } from './interface.js';
import type { ResearchChainKey } from '../types.js';
import type { OnchainTxGraphNode } from '../types.js';
import { ExplorerResolver } from '../explorer-resolver.js';
import { LiveRpcCallFailedError } from '../errors.js';

/** Real Morpho Blue singleton address (verified: docs.morpho.org/morpho/addresses/). */
export const MORPHO_BLUE_ADDRESS = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const;

/**
 * Minimal ABI slice actually used by this adapter, transcribed from
 * morpho-org/morpho-blue's IMorphoStaticTyping / EventsLib.sol (GitHub,
 * `main` branch, verified during implementation — see file header).
 */
const MORPHO_BLUE_ABI = [
  {
    type: 'function',
    name: 'market',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'position',
    stateMutability: 'view',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'idToMarketParams',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'Liquidate',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'borrower', type: 'address', indexed: true },
      { name: 'repaidAssets', type: 'uint256', indexed: false },
      { name: 'repaidShares', type: 'uint256', indexed: false },
      { name: 'seizedAssets', type: 'uint256', indexed: false },
      { name: 'badDebtAssets', type: 'uint256', indexed: false },
      { name: 'badDebtShares', type: 'uint256', indexed: false },
    ],
  },
] as const;

export class MorphoBlueAdapter implements ProtocolAdapter {
  public readonly protocol = 'morpho-blue' as const;
  public readonly supportedChains: ResearchChainKey[] = ['ethereum-mainnet', 'base-mainnet'];

  constructor(private readonly client: PublicClient, private readonly chain: ResearchChainKey) {}

  public async fetchPositionContext(subject: SubjectContext): Promise<PositionHealthSnapshot> {
    const id = subject.identifier as `0x${string}`;

    try {
      const [marketState, marketParams] = await Promise.all([
        this.client.readContract({
          address: MORPHO_BLUE_ADDRESS,
          abi: MORPHO_BLUE_ABI,
          functionName: 'market',
          args: [id],
        }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>,
        this.client.readContract({
          address: MORPHO_BLUE_ADDRESS,
          abi: MORPHO_BLUE_ABI,
          functionName: 'idToMarketParams',
          args: [id],
        }) as Promise<readonly [string, string, string, string, bigint]>,
      ]);

      const [totalSupplyAssets, , totalBorrowAssets] = marketState;
      const lltv = marketParams[4];
      const liquidationThresholdLtv = Number(lltv) / 1e18;

      // If a borrower address is also known (subject.type === 'borrower'),
      // fetch the individual position; otherwise fall back to market-level
      // aggregate state (subject.type === 'market_id').
      let collateralRaw = 0n;
      let borrowShares = 0n;
      if (subject.type === 'borrower') {
        const position = (await this.client.readContract({
          address: MORPHO_BLUE_ADDRESS,
          abi: MORPHO_BLUE_ABI,
          functionName: 'position',
          args: [id, subject.identifier as `0x${string}`],
        })) as readonly [bigint, bigint, bigint];
        [, borrowShares, collateralRaw] = position;
      }

      // NOTE: precise USD valuation requires the market's oracle price feed
      // (marketParams.oracle), which is intentionally out of scope for this
      // adapter pass — collateral/debt are reported in raw loan-asset units
      // here (6-decimal-stablecoin-shaped scaling assumed) rather than a
      // fabricated USD figure. Callers needing exact USD amounts should
      // resolve marketParams.oracle separately.
      const totalDebtUsd = Number(totalBorrowAssets) / 1e6;
      const totalCollateralUsd = subject.type === 'borrower' ? Number(collateralRaw) / 1e6 : Number(totalSupplyAssets) / 1e6;
      const currentLtv = totalCollateralUsd > 0 ? totalDebtUsd / totalCollateralUsd : 0;
      const healthFactor = currentLtv > 0 ? liquidationThresholdLtv / currentLtv : Infinity;

      return {
        protocol: this.protocol,
        chain: this.chain,
        subjectIdentifier: subject.identifier,
        totalCollateralUsd,
        totalDebtUsd,
        currentLtv,
        liquidationThresholdLtv,
        healthFactor,
        // Real borrow/supply APY requires reading the market's IRM contract
        // (marketParams.irm) and applying its rate curve — out of scope for
        // this pass; adapters report 0 rather than a fabricated rate until
        // Task 13's strategy engine wires a real IRM read.
        borrowApy: 0,
        supplyApy: 0,
        utilizationRate: Number(totalSupplyAssets) > 0 ? Number(totalBorrowAssets) / Number(totalSupplyAssets) : 0,
      };
    } catch (err) {
      throw new LiveRpcCallFailedError('morpho-blue', err instanceof Error ? err.message : String(err));
    }
  }

  public async fetchRecentLiquidationEvents(subject: SubjectContext, lookbackBlocks: number): Promise<OnchainTxGraphNode[]> {
    try {
      const currentBlock = await this.client.getBlockNumber();
      const fromBlock = currentBlock > BigInt(lookbackBlocks) ? currentBlock - BigInt(lookbackBlocks) : 0n;

      const logs = await this.client.getLogs({
        address: MORPHO_BLUE_ADDRESS,
        event: MORPHO_BLUE_ABI[3],
        args: { id: subject.identifier as `0x${string}` },
        fromBlock,
        toBlock: currentBlock,
      });

      return logs.map((log: any, idx: number): OnchainTxGraphNode => {
        const txHash = log.transactionHash as `0x${string}`;
        return {
          nodeId: `morpho-liq-${txHash.slice(0, 10)}-${idx}`,
          txHash,
          blockNumber: Number(log.blockNumber),
          timestamp: Math.floor(Date.now() / 1000),
          primaryAction: 'LIQUIDATE_CALL',
          protocol: this.protocol,
          chain: this.chain,
          caller: log.args?.caller ?? '0x0000000000000000000000000000000000000000',
          contractTarget: MORPHO_BLUE_ADDRESS,
          explorerLinks: ExplorerResolver.resolve(this.chain, txHash),
          financials: {
            assetSymbol: 'UNKNOWN', // requires resolving marketParams.loanToken -> ERC20 symbol()
            amountRaw: (log.args?.repaidAssets ?? 0n).toString(),
            amountFormatted: Number(log.args?.repaidAssets ?? 0n) / 1e6,
          },
          riskContributionScore: 85,
        };
      });
    } catch (err) {
      throw new LiveRpcCallFailedError('morpho-blue', err instanceof Error ? err.message : String(err));
    }
  }
}
