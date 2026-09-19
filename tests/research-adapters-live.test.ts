/**
 * Live-gated on-chain read tests for OnchainLendingResearchService adapters.
 *
 * Runs ONLY when RUN_LIVE_ONCHAIN_TESTS=true. These make real, read-only RPC
 * calls against public mainnet endpoints (per plan requirement #4 — no
 * dedicated RPC provider credentials are provisioned yet). They are
 * excluded from the default `npm test` run (see Task 16) to keep the
 * default suite fast, deterministic, and offline.
 *
 * Run with: `npm run test:live-onchain` (or `RUN_LIVE_ONCHAIN_TESTS=true npx vitest run tests/research-adapters-live.test.ts`)
 */
import { describe, it, expect } from 'vitest';
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { MorphoBlueAdapter } from '../src/research/adapters/morpho.js';
import { AaveV3Adapter } from '../src/research/adapters/aave.js';
import { PendleAdapter } from '../src/research/adapters/pendle.js';
import { EulerV2Adapter } from '../src/research/adapters/euler.js';
import { SiloAdapter } from '../src/research/adapters/silo.js';

const RUN_LIVE = process.env.RUN_LIVE_ONCHAIN_TESTS === 'true';
const PUBLIC_RPC_URL = process.env.RESEARCH_RPC_URL_ETHEREUM ?? 'https://ethereum-rpc.publicnode.com';

describe.runIf(RUN_LIVE)('MorphoBlueAdapter — live on-chain reads', () => {
  it('reads real market() state for the permanent USDC idle market', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(PUBLIC_RPC_URL) });
    const adapter = new MorphoBlueAdapter(client, 'ethereum-mainnet');

    // Real, permanent Morpho Blue idle USDC market (verified via
    // docs.morpho.org/morpho/tutorials/market-creation — idle markets use
    // the zero address for collateralToken/oracle/irm and persist forever).
    const IDLE_USDC_MARKET_ID = '0x54efdee08e272e929034a8f26f7ca34b1ebe364b275391169b28c6d7db24dbc8';

    const snapshot = await adapter.fetchPositionContext({
      type: 'market_id',
      identifier: IDLE_USDC_MARKET_ID,
    });

    expect(snapshot.protocol).toBe('morpho-blue');
    expect(snapshot.chain).toBe('ethereum-mainnet');
    // An idle market has liquidationThresholdLtv = 0 (LLTV param is 0 for idle markets).
    expect(snapshot.liquidationThresholdLtv).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(snapshot.totalDebtUsd)).toBe(true);
    expect(Number.isFinite(snapshot.totalCollateralUsd)).toBe(true);
  }, 30_000);
});

describe.runIf(RUN_LIVE)('AaveV3Adapter — live on-chain reads', () => {
  it('reads real getUserAccountData() for an address with no Aave position (well-formed zero snapshot)', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(PUBLIC_RPC_URL) });
    const adapter = new AaveV3Adapter(client, 'ethereum-mainnet');

    // A well-known address with no Aave v3 position (zero address never has
    // one) — proves the real Pool.getUserAccountData() call and the
    // "no debt" sentinel-to-Infinity normalization work end-to-end without
    // depending on any particular borrower's position remaining stable.
    const snapshot = await adapter.fetchPositionContext({
      type: 'borrower',
      identifier: '0x0000000000000000000000000000000000000001',
    });

    expect(snapshot.protocol).toBe('aave-v3');
    expect(snapshot.totalCollateralUsd).toBe(0);
    expect(snapshot.totalDebtUsd).toBe(0);
    expect(snapshot.healthFactor).toBe(Infinity);
  }, 30_000);
});

describe.runIf(RUN_LIVE)('PendleAdapter — live on-chain reads', () => {
  it('reads real expiry() + oracle state for a live, long-dated wstETH PT market', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(PUBLIC_RPC_URL) });
    const adapter = new PendleAdapter(client, 'ethereum-mainnet');

    // Real, currently-active Pendle wstETH market (verified live via
    // https://api-v2.pendle.finance/core/v1/1/markets/active during
    // implementation — expiry 2027-12-30, $5.2M liquidity at verification
    // time, chosen for longevity so this test doesn't go stale quickly).
    const WSTETH_MARKET_ADDRESS = '0x34280882267ffa6383b363e278b027be083bbe3b';

    const snapshot = await adapter.fetchPositionContext({
      type: 'pt_address',
      identifier: WSTETH_MARKET_ADDRESS,
    });

    expect(snapshot.protocol).toBe('pendle');
    expect(snapshot.healthFactor).toBe(Infinity); // unleveraged PT is never liquidatable
    expect(snapshot.macaulayDurationDays).toBeGreaterThan(0);
    expect(Number.isFinite(snapshot.supplyApy)).toBe(true);
  }, 30_000);
});

describe.runIf(RUN_LIVE)('EulerV2Adapter — live on-chain reads', () => {
  it('reads real totalAssets()/totalBorrows() for a known, real EVault (K3 Capital Prime Market)', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(PUBLIC_RPC_URL) });
    const adapter = new EulerV2Adapter(client, 'ethereum-mainnet');

    // Real, currently-known EVault per Euler's own public API (verified
    // live via https://app.euler.finance/api/public/is-known during
    // implementation — "K3 Capital Prime Market", USDC-denominated).
    const K3_PRIME_MARKET_VAULT = '0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9';

    const snapshot = await adapter.fetchPositionContext({
      type: 'vault_address',
      identifier: K3_PRIME_MARKET_VAULT,
    });

    expect(snapshot.protocol).toBe('euler-v2');
    expect(Number.isFinite(snapshot.totalCollateralUsd)).toBe(true);
    expect(Number.isFinite(snapshot.utilizationRate)).toBe(true);
    expect(snapshot.utilizationRate).toBeGreaterThanOrEqual(0);
    expect(snapshot.utilizationRate).toBeLessThanOrEqual(1.001); // allow tiny rounding above 100%
  }, 30_000);
});

describe.runIf(RUN_LIVE)('SiloAdapter — live on-chain reads', () => {
  it('verifies the real, corrected SiloFactory address resolves and rejects a non-Silo address via isSilo()', async () => {
    const client = createPublicClient({ chain: mainnet, transport: http(PUBLIC_RPC_URL) });

    // This directly exercises the SILO_FACTORY_ADDRESSES correction made
    // during implementation: the address originally taken from DefiLlama's
    // page-level methodology STRING (0xa42001d6...) has zero contract code
    // on Ethereum mainnet (confirmed via a live eth_getCode call before
    // this fix); the real address used by DefiLlama's own EXECUTABLE
    // adapter code (configV2) is 0x22a3cF61... and is used here.
    const adapter = new SiloAdapter(client, 'ethereum-mainnet');

    // A definitely-not-a-Silo address (the well-known "dead" burn address)
    // must resolve to false via the real on-chain isSilo() call — proving
    // the corrected factory address is live and the ABI call succeeds,
    // without depending on any specific market's address staying valid.
    await expect(
      adapter.fetchPositionContext({
        type: 'vault_address',
        identifier: '0x000000000000000000000000000000000000dEaD',
      }),
    ).rejects.toThrow(/not a known Silo/i);
  }, 30_000);
});
