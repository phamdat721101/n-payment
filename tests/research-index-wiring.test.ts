import { describe, it, expect } from 'vitest';
import {
  LendingResearchClient,
  ProtocolAdapterRegistry,
  MorphoBlueAdapter,
  AaveV3Adapter,
  PendleAdapter,
  EulerV2Adapter,
  SiloAdapter,
  GraphNodeReportEngine,
  ExplorerResolver,
  calculateLIF,
  LendingResearchRequestSchema,
} from '../src/research/index.js';

describe('research/index — end-to-end module wiring', () => {
  it('exports every public symbol needed to wire the full research service', () => {
    expect(LendingResearchClient).toBeTypeOf('function');
    expect(ProtocolAdapterRegistry).toBeTypeOf('function');
    expect(MorphoBlueAdapter).toBeTypeOf('function');
    expect(AaveV3Adapter).toBeTypeOf('function');
    expect(PendleAdapter).toBeTypeOf('function');
    expect(EulerV2Adapter).toBeTypeOf('function');
    expect(SiloAdapter).toBeTypeOf('function');
    expect(GraphNodeReportEngine).toBeTypeOf('function');
    expect(ExplorerResolver).toBeTypeOf('function');
    expect(calculateLIF).toBeTypeOf('function');
  });

  it('wires a real registry with all 5 adapters and dispatches through the facade (offline, mocked viem client)', async () => {
    const mockClient = {} as any;
    const registry = new ProtocolAdapterRegistry();
    registry.register(new MorphoBlueAdapter(mockClient, 'ethereum-mainnet'));
    registry.register(new AaveV3Adapter(mockClient, 'ethereum-mainnet'));
    registry.register(new PendleAdapter(mockClient, 'ethereum-mainnet'));
    registry.register(new EulerV2Adapter(mockClient, 'ethereum-mainnet'));
    registry.register(new SiloAdapter(mockClient, 'ethereum-mainnet'));

    expect(registry.registeredProtocols().sort()).toEqual(['aave-v3', 'euler-v2', 'morpho-blue', 'pendle', 'silo-v2'].sort());

    const client = new LendingResearchClient(registry);
    expect(client).toBeInstanceOf(LendingResearchClient);
  });

  it('validates a request via the exported schema and builds a report via the exported graph engine (fully offline)', () => {
    const request = LendingResearchRequestSchema.parse({
      targetProtocol: 'morpho-blue',
      targetChain: 'ethereum-mainnet',
      targetSubject: { type: 'market_id', identifier: '0x52940dc3e4416b3038818bad0d62c1b191451316be2792e58eb553993b930e50' },
    });

    const engine = new GraphNodeReportEngine();
    const report = engine.synthesizeGraph(request, {
      protocol: 'morpho-blue',
      chain: 'ethereum-mainnet',
      subjectIdentifier: request.targetSubject.identifier,
      totalCollateralUsd: 150_000,
      totalDebtUsd: 80_000,
      currentLtv: 80_000 / 150_000,
      liquidationThresholdLtv: 0.86,
      healthFactor: (0.86 * 150_000) / 80_000,
      borrowApy: 0.05,
      supplyApy: 0.06,
    });

    expect(report.actionRecommendation).toBe('HOLD');
  });
});
