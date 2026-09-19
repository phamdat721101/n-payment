/**
 * v0.31 — Causal DAG node/edge assembly + cycle detection for
 * GraphNodeReportEngine.
 *
 * PRD-07's CHAOS-04 calls for cycle detection via Kahn's algorithm before
 * serialization — implemented here as `assertAcyclic()`. PRD-03's own
 * code sample (report-engine.ts) omitted this guard entirely; this module
 * adds it as a genuinely new safety layer, not merely ported PRD code.
 */
import type { OnchainTxGraphNode, CausalEdge } from '../types.js';
import { CyclicCausalGraphError } from '../errors.js';

/**
 * Kahn's algorithm: repeatedly remove nodes with in-degree 0. If any nodes
 * remain after the queue empties, the graph contains a cycle.
 */
export function assertAcyclic(nodes: OnchainTxGraphNode[], edges: CausalEdge[]): void {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.nodeId, 0);
    adjacency.set(node.nodeId, []);
  }

  for (const edge of edges) {
    if (!adjacency.has(edge.sourceNodeId) || !inDegree.has(edge.targetNodeId)) {
      // Edge references a node not present in this graph snapshot — treat
      // as a dangling reference, not a cycle (out of scope for this guard).
      continue;
    }
    adjacency.get(edge.sourceNodeId)!.push(edge.targetNodeId);
    inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) queue.push(nodeId);
  }

  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, nextDegree);
      if (nextDegree === 0) queue.push(neighbor);
    }
  }

  if (visited < nodes.length) {
    throw new CyclicCausalGraphError();
  }
}
