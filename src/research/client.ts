/**
 * v0.31 — LendingResearchClient: the public facade for
 * OnchainLendingResearchService. Validates the request (Zod boundary
 * guard), dispatches to the correct protocol adapter via the registry,
 * and returns a normalized PositionHealthSnapshot.
 *
 * This pass's scope (per plan Task 10) is the request -> adapter dispatch
 * -> normalized snapshot path only. Full GraphNodeReport synthesis
 * (causal DAG assembly) is wired in Task 12 via GraphNodeReportEngine
 * (Task 11), not duplicated here.
 */
import { LendingResearchRequestSchema } from './types.js';
import type { z } from 'zod';
import type { PositionHealthSnapshot } from './adapters/interface.js';
import type { ProtocolAdapterRegistry } from './adapters/registry.js';

export class LendingResearchClient {
  constructor(private readonly registry: ProtocolAdapterRegistry) {}

  /**
   * Accepts the Zod INPUT type (fields with `.default()` are optional here)
   * rather than the stricter post-default OUTPUT type — callers should be
   * able to omit `includeMevTrace`/`blockRangeLookback` and let the schema
   * apply its documented defaults, exactly as LendingResearchRequestSchema
   * itself allows.
   */
  public async auditLendingPosition(rawRequest: z.input<typeof LendingResearchRequestSchema>): Promise<PositionHealthSnapshot> {
    const request = LendingResearchRequestSchema.parse(rawRequest);
    const adapter = this.registry.getAdapter(request.targetProtocol, request.targetChain);
    return adapter.fetchPositionContext(request.targetSubject);
  }
}
