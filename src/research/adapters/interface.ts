/**
 * v0.31 — Unified protocol adapter interface for OnchainLendingResearchService.
 * Every protocol adapter (Morpho, Aave, Pendle, Euler, Silo) implements this
 * so the registry/facade (Task 10) can dispatch without protocol-specific
 * branching.
 */
import type { LendingProtocolType, LendingSubjectType, ResearchChainKey } from '../types.js';
import type { OnchainTxGraphNode } from '../types.js';

export interface SubjectContext {
  type: LendingSubjectType;
  identifier: string;
}

export interface PositionHealthSnapshot {
  protocol: LendingProtocolType;
  chain: ResearchChainKey;
  subjectIdentifier: string;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  currentLtv: number;
  liquidationThresholdLtv: number;
  /** Infinity for zero-debt positions (e.g. unleveraged Pendle PT holdings). */
  healthFactor: number;
  borrowApy: number;
  supplyApy: number;
  utilizationRate?: number;
  macaulayDurationDays?: number;
}

export interface ProtocolAdapter {
  readonly protocol: LendingProtocolType;
  readonly supportedChains: ResearchChainKey[];

  fetchPositionContext(subject: SubjectContext): Promise<PositionHealthSnapshot>;
  fetchRecentLiquidationEvents(subject: SubjectContext, lookbackBlocks: number): Promise<OnchainTxGraphNode[]>;
}
