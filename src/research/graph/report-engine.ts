/**
 * v0.31 — GraphNodeReportEngine: synthesizes a GraphNodeReport from a
 * LendingResearchRequest + normalized PositionHealthSnapshot (+ optional
 * pre-fetched causal-DAG nodes/edges from a protocol adapter's
 * fetchRecentLiquidationEvents()).
 *
 * Ported largely as PRD-03 specified (this module's core logic — risk
 * scoring, action-recommendation state machine, markdown generation — is
 * pure, protocol-agnostic decision logic with no live-chain dependency,
 * genuinely implementable as designed) but ADDS the cycle-detection guard
 * (CHAOS-04) that PRD-03's own code sample omitted — see graph/builder.ts.
 */
import type { LendingResearchRequest, GraphNodeReport, OnchainTxGraphNode, CausalEdge } from '../types.js';
import type { PositionHealthSnapshot } from '../adapters/interface.js';
import { assertAcyclic } from './builder.js';

export interface GraphInputs {
  nodes: OnchainTxGraphNode[];
  edges: CausalEdge[];
}

export class GraphNodeReportEngine {
  public synthesizeGraph(
    request: LendingResearchRequest,
    snapshot: PositionHealthSnapshot,
    graph: GraphInputs = { nodes: [], edges: [] },
  ): GraphNodeReport {
    assertAcyclic(graph.nodes, graph.edges);

    const riskScore = this.computeRiskScore(snapshot);
    const actionRecommendation = this.computeActionRecommendation(snapshot, riskScore);
    const netCarryYieldBps = Math.round((snapshot.supplyApy - snapshot.borrowApy) * 10000);
    const markdownAuditReport = this.generateMarkdownSummary(request, snapshot, riskScore, actionRecommendation);

    return {
      reportId: `REP-${Date.now()}-${request.targetSubject.identifier.slice(0, 10)}`,
      generatedAt: Math.floor(Date.now() / 1000),
      targetSubject: request.targetSubject,
      summary: {
        riskScore,
        healthFactor: snapshot.healthFactor,
        estimatedDaysToLiquidation: null,
        macaulayDurationDays: snapshot.macaulayDurationDays,
        netCarryYieldBps,
      },
      nodes: graph.nodes,
      edges: graph.edges,
      actionRecommendation,
      markdownAuditReport,
    };
  }

  private computeRiskScore(snapshot: PositionHealthSnapshot): number {
    let riskScore: number;
    if (snapshot.healthFactor < 1.0) {
      riskScore = 100;
    } else if (snapshot.healthFactor < 1.15) {
      riskScore = 85;
    } else if (snapshot.utilizationRate !== undefined && snapshot.utilizationRate > 0.92) {
      riskScore = 75;
    } else if (snapshot.liquidationThresholdLtv > 0) {
      riskScore = Math.round((snapshot.currentLtv / snapshot.liquidationThresholdLtv) * 60);
    } else {
      riskScore = 10;
    }
    return Math.max(0, Math.min(100, riskScore));
  }

  private computeActionRecommendation(
    snapshot: PositionHealthSnapshot,
    riskScore: number,
  ): GraphNodeReport['actionRecommendation'] {
    if (riskScore >= 85) {
      return 'EMERGENCY_DELEVERAGE';
    }
    if (snapshot.utilizationRate !== undefined && snapshot.utilizationRate > 0.92) {
      return 'DEFEND_KINK';
    }
    if (snapshot.borrowApy > snapshot.supplyApy) {
      return 'REBALANCE_TO_PT';
    }
    return 'HOLD';
  }

  private generateMarkdownSummary(
    req: LendingResearchRequest,
    snap: PositionHealthSnapshot,
    risk: number,
    action: string,
  ): string {
    const healthFactorDisplay = Number.isFinite(snap.healthFactor) ? snap.healthFactor.toFixed(3) : '∞';
    return `### Position Audit: ${req.targetProtocol} (${req.targetChain})
- **Subject:** \`${req.targetSubject.identifier}\`
- **Health Factor:** ${healthFactorDisplay} | **Risk Score:** ${risk}/100
- **LTV:** ${(snap.currentLtv * 100).toFixed(2)}% (Max LLTV: ${(snap.liquidationThresholdLtv * 100).toFixed(2)}%)
- **Action Signal:** \`${action}\``;
  }
}
