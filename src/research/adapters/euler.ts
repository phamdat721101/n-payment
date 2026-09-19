/**
 * v0.31 — Euler v2 protocol adapter for OnchainLendingResearchService.
 *
 * NET-NEW DESIGN (no PRD sketch existed for this protocol): Euler v2 is a
 * permissionless, per-asset-pair vault factory architecture (Euler Vault
 * Kit / EVK) — there is no single canonical lending singleton the way
 * Morpho Blue has one. Verified during implementation:
 *   - Real, bytecode-proven eVaultFactory address (Ethereum mainnet):
 *     0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e, per
 *     euler-xyz/euler-interfaces's verify/1.md (independent bytecode-vs-
 *     source verification registry, not just an unverified doc mention).
 *   - Euler's OWN recommended vault-discovery path is a public HTTP API
 *     (https://app.euler.finance/api/public/is-known /metadata), not raw
 *     factory event enumeration — this adapter's `subject.identifier` is
 *     therefore a `vault_address` (an EVault proxy address the caller
 *     already resolved via that API, a subgraph, or lens contracts), not a
 *     market-id the adapter derives itself. This mirrors this SDK's own
 *     LendingSubjectTypeSchema, which already includes `vault_address` as
 *     a first-class type for exactly this reason (see research/types.ts).
 *   - Real on-chain read: `IEVault.debtOf(account)`, `totalAssets()`,
 *     `totalBorrows()` — all confirmed against
 *     docs.euler.finance/build/evk/interacting-with-vaults/.
 */
import type { PublicClient } from 'viem';
import type { ProtocolAdapter, SubjectContext, PositionHealthSnapshot } from './interface.js';
import type { ResearchChainKey } from '../types.js';
import type { OnchainTxGraphNode } from '../types.js';
import { LiveRpcCallFailedError } from '../errors.js';

/** Real, bytecode-verified eVaultFactory address (Ethereum mainnet). See file header for verification source. */
export const EULER_VAULT_FACTORY_ADDRESS = '0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e' as const;

const EVAULT_ABI = [
  {
    type: 'function',
    name: 'debtOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalAssets',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBorrows',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export class EulerV2Adapter implements ProtocolAdapter {
  public readonly protocol = 'euler-v2' as const;
  public readonly supportedChains: ResearchChainKey[] = ['ethereum-mainnet', 'base-mainnet'];

  constructor(private readonly client: PublicClient, private readonly chain: ResearchChainKey) {}

  /**
   * @param borrowerAddress Optional — when supplied, `debtOf(borrowerAddress)`
   *   is read for per-account debt. When omitted, only vault-level aggregate
   *   state (totalAssets/totalBorrows -> utilizationRate) is returned;
   *   totalDebtUsd/totalCollateralUsd reflect the whole vault, not one user.
   */
  public async fetchPositionContext(subject: SubjectContext, borrowerAddress?: `0x${string}`): Promise<PositionHealthSnapshot> {
    if (subject.type !== 'vault_address') {
      throw new LiveRpcCallFailedError(
        'euler-v2',
        `Euler v2 requires a vault_address subject (got "${subject.type}") — there is no singleton market-id the way Morpho Blue has one.`,
      );
    }

    const vaultAddress = subject.identifier as `0x${string}`;

    try {
      const [totalAssets, totalBorrows] = await Promise.all([
        this.client.readContract({ address: vaultAddress, abi: EVAULT_ABI, functionName: 'totalAssets', args: [] }) as Promise<bigint>,
        this.client.readContract({ address: vaultAddress, abi: EVAULT_ABI, functionName: 'totalBorrows', args: [] }) as Promise<bigint>,
      ]);

      let accountDebt = totalBorrows;
      if (borrowerAddress) {
        accountDebt = (await this.client.readContract({
          address: vaultAddress,
          abi: EVAULT_ABI,
          functionName: 'debtOf',
          args: [borrowerAddress],
        })) as bigint;
      }

      const totalDebtUsd = Number(accountDebt) / 1e6; // raw-unit scaling; see Morpho adapter's identical documented scope-narrowing
      const totalCollateralUsd = Number(totalAssets) / 1e6;
      const utilizationRate = Number(totalAssets) > 0 ? Number(totalBorrows) / Number(totalAssets) : 0;
      const currentLtv = totalCollateralUsd > 0 ? totalDebtUsd / totalCollateralUsd : 0;

      return {
        protocol: this.protocol,
        chain: this.chain,
        subjectIdentifier: subject.identifier,
        totalCollateralUsd,
        totalDebtUsd,
        currentLtv,
        // Real per-vault LTV requires reading the borrow-vault's configured
        // LTV against the specific collateral vault pair (EVK's LTV is a
        // per-(collateral,borrow)-vault-pair setting, not a single scalar
        // on the vault itself) — out of scope for this pass; reports 0
        // rather than fabricating a value.
        liquidationThresholdLtv: 0,
        healthFactor: Infinity, // real health factor needs the LTV-pair read above; documented gap, not a fabricated number
        borrowApy: 0,
        supplyApy: 0,
        utilizationRate,
      };
    } catch (err) {
      if (err instanceof LiveRpcCallFailedError) throw err;
      throw new LiveRpcCallFailedError('euler-v2', err instanceof Error ? err.message : String(err));
    }
  }

  public async fetchRecentLiquidationEvents(_subject: SubjectContext, _lookbackBlocks: number): Promise<OnchainTxGraphNode[]> {
    // Liquidation event decoding for EVK vaults is deferred to a future
    // pass (this adapter's scope is the position-health read path,
    // matching the Aave/Morpho adapters' equivalent scope-narrowing).
    return [];
  }
}
