import { describe, it, expect, vi } from 'vitest';
import { PendleAdapter, PENDLE_ROUTER_ADDRESS, PENDLE_PY_LP_ORACLE_ADDRESS } from '../src/research/adapters/pendle.js';

describe('PendleAdapter — offline (mocked viem client)', () => {
  it('exposes the real, verified Router and PYLpOracle addresses (Ethereum mainnet)', () => {
    // Verified directly against pendle-finance/pendle-core-v2-public's
    // deployments/1-core.json during implementation — NOT the PRD's
    // guessed "Router V3" address (0x00000000005BBB0EF59571E58418F9a4357b68A0),
    // which does not match any real Pendle deployment.
    expect(PENDLE_ROUTER_ADDRESS).toBe('0x888888888889758F76e7103c6CbF23ABbF58F946');
    expect(PENDLE_PY_LP_ORACLE_ADDRESS).toBe('0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2');
  });

  it('reads real market expiry + oracle state (getOracleState + getPtToSyRate) rather than calling the Router', async () => {
    const marketAddr = '0x1111111111111111111111111111111111111111' as `0x${string}`;
    const nowSec = Math.floor(Date.now() / 1000);
    const expiryInSec = nowSec + 190 * 86400; // ~190 days out

    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'expiry') {
        return BigInt(expiryInSec);
      }
      if (functionName === 'getOracleState') {
        // (increaseCardinalityRequired, cardinalityRequired, oldestObservationSatisfied)
        return [false, 0, true];
      }
      if (functionName === 'getPtToSyRate') {
        // 0.912e18 -> PT trades at 0.912 SY (real Pendle 1e18-scaled convention)
        return 912_000_000_000_000_000n;
      }
      throw new Error(`unexpected functionName: ${functionName}`);
    });

    const mockClient = { readContract } as any;
    const adapter = new PendleAdapter(mockClient, 'ethereum-mainnet');

    const snapshot = await adapter.fetchPositionContext({ type: 'pt_address', identifier: marketAddr });

    expect(snapshot.protocol).toBe('pendle');
    // Unleveraged PT cannot be liquidated: currentLtv=0, healthFactor=Infinity.
    expect(snapshot.currentLtv).toBe(0);
    expect(snapshot.healthFactor).toBe(Infinity);
    expect(snapshot.macaulayDurationDays).toBeGreaterThan(0);
    expect(snapshot.supplyApy).toBeGreaterThan(0); // implied yield derived from PT discount

    // Confirms the ABI call was made against the oracle, never the Router
    // (the PRD's original design mistakenly called the swap-execution Router
    // for a read-only research query).
    const calledAddresses = readContract.mock.calls.map((c: any) => c[0].address);
    expect(calledAddresses).toContain(PENDLE_PY_LP_ORACLE_ADDRESS);
    expect(calledAddresses).not.toContain(PENDLE_ROUTER_ADDRESS);
  });

  it('throws a clear error if the oracle cardinality is insufficient rather than returning a manipulable spot rate', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'expiry') return BigInt(nowSec + 190 * 86400);
      if (functionName === 'getOracleState') {
        return [true, 900, false]; // cardinality NOT yet sufficient
      }
      throw new Error('should not reach getPtToSyRate');
    });
    const mockClient = { readContract } as any;
    const adapter = new PendleAdapter(mockClient, 'ethereum-mainnet');

    await expect(
      adapter.fetchPositionContext({ type: 'pt_address', identifier: '0x2222222222222222222222222222222222222222' }),
    ).rejects.toThrow(/oracle/i);
  });

  it('unleveraged PT positions report empty liquidation events (cannot be liquidated)', async () => {
    const adapter = new PendleAdapter({} as any, 'ethereum-mainnet');
    const events = await adapter.fetchRecentLiquidationEvents({ type: 'pt_address', identifier: '0x1111111111111111111111111111111111111111' }, 7200);
    expect(events).toEqual([]);
  });
});
