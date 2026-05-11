import type { AgentCardData, AgentProviderConfig } from './types.js';

/** A2A-compatible Agent Card for service advertisement */
export class AgentCard {
  private data: AgentCardData;

  constructor(data: AgentCardData) {
    this.data = data;
  }

  /** Generate from AgentProvider config */
  static fromProvider(config: AgentProviderConfig, url: string): AgentCard {
    return new AgentCard({
      name: config.name,
      description: config.description,
      url,
      skills: config.tools.map(t => ({
        name: t.name,
        description: t.description,
        price: typeof t.price === 'number' ? t.price : t.price.basePrice,
        pricingMode: 'per-call',
        inputSchema: t.inputSchema,
      })),
      chains: [config.chain],
      protocols: ['x402', 'a2a'],
      payTo: config.payTo,
    });
  }

  /** Serialize to JSON (for /.well-known/agent.json) */
  toJSON(): AgentCardData & { version: string } {
    return { version: '1.0', ...this.data };
  }

  /** Express handler for /.well-known/agent.json */
  handler() {
    return (_req: any, res: any) => {
      res.status(200).json(this.toJSON());
    };
  }
}
