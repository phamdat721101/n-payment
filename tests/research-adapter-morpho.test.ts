import { describe, it, expect, vi } from 'vitest';
import { MorphoBlueAdapter, MORPHO_BLUE_ADDRESS } from '../src/research/adapters/morpho.js';

describe('MorphoBlueAdapter — offline (mocked viem client)', () => {
  it('exposes the real, verified Morpho Blue singleton address', () => {
    // Verified against docs.morpho.org/morpho/addresses/ during implementation.
    expect(MORPHO_BLUE_ADDRESS).toBe('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
  });

  it('normalizes market()/position() reads into a PositionHealthSnapshot', async () => {
    const marketId = '0xfc91948b556d7529ad6f5318825286ed2c34d862427b4832817e880a7edbd160' as `0x${string}`;
    const userAddr = '0x1111111111111111111111111111111111111111' as `0x${string}`;

    // Mock viem PublicClient.readContract to return realistic Morpho Blue
    // market()/position() tuples (real ABI shape verified against
    // morpho-org/morpho-blue's IMorpho.sol / IMorphoStaticTyping on GitHub).
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'market') {
        // (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee)
        return [200_000_000_000n, 200_000_000_000_000_000_000n, 120_000_000_000n, 118_000_000_000_000_000_000n, 1735000000n, 0n];
      }
      if (functionName === 'position') {
        // (supplyShares, borrowShares, collateral)
        return [0n, 118_000_000_000_000_000_000n, 150_000_000_000n];
      }
      if (functionName === 'idToMarketParams') {
        return ['0xLoanToken', '0xCollateralToken', '0xOracle', '0xIrm', 860000000000000000n];
      }
      throw new Error(`unexpected functionName: ${functionName}`);
    });

    const mockClient = { readContract } as any;
    const adapter = new MorphoBlueAdapter(mockClient, 'ethereum-mainnet');

    const snapshot = await adapter.fetchPositionContext({ type: 'market_id', identifier: marketId });

    expect(snapshot.protocol).toBe('morpho-blue');
    expect(snapshot.chain).toBe('ethereum-mainnet');
    expect(snapshot.liquidationThresholdLtv).toBeCloseTo(0.86, 5);
    expect(snapshot.totalDebtUsd).toBeGreaterThan(0);
    expect(snapshot.totalCollateralUsd).toBeGreaterThan(0);
    expect(snapshot.healthFactor).toBeGreaterThan(0);
    expect(readContract).toHaveBeenCalled();
  });

  it('decodes real Liquidate event logs into normalized OnchainTxGraphNode entries', async () => {
    const marketId = '0xfc91948b556d7529ad6f5318825286ed2c34d862427b4832817e880a7edbd160' as `0x${string}`;

    // Shape matches the REAL EventsLib.sol Liquidate event (verified via
    // github.com/morpho-org/morpho-blue/blob/main/src/libraries/EventsLib.sol):
    // event Liquidate(Id indexed id, address indexed caller, address indexed borrower,
    //   uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets,
    //   uint256 badDebtAssets, uint256 badDebtShares)
    // NOTE: this corrects the original PRD's guessed signature, which used the
    // wrong field name `returnedAssets` and omitted `badDebtShares` entirely.
    const getLogs = vi.fn(async () => [
      {
        transactionHash: '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50',
        blockNumber: 21000000n,
        args: {
          id: marketId,
          caller: '0x2222222222222222222222222222222222222222',
          borrower: '0x1111111111111111111111111111111111111111',
          repaidAssets: 10_000_000_000n,
          repaidShares: 9_800_000_000_000_000_000n,
          seizedAssets: 11_000_000_000n,
          badDebtAssets: 0n,
          badDebtShares: 0n,
        },
      },
    ]);
    const getBlockNumber = vi.fn(async () => 21000100n);
    const mockClient = { getLogs, getBlockNumber } as any;
    const adapter = new MorphoBlueAdapter(mockClient, 'ethereum-mainnet');

    const nodes = await adapter.fetchRecentLiquidationEvents({ type: 'market_id', identifier: marketId }, 7200);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].primaryAction).toBe('LIQUIDATE_CALL');
    expect(nodes[0].protocol).toBe('morpho-blue');
    expect(nodes[0].explorerLinks.standardExplorer).toContain('etherscan.io/tx/');
    expect(nodes[0].contractTarget).toBe(MORPHO_BLUE_ADDRESS);
  });
});
