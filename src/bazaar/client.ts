import type { BazaarResource, BazaarSearchResult } from '../types.js';
import { MOCK_CATALOG } from './mock-catalog.js';

export interface BazaarClientConfig {
  facilitatorUrl?: string;
  mockCatalog?: boolean;
}

export class BazaarClient {
  private facilitatorUrl?: string;
  private useMock: boolean;

  constructor(config: BazaarClientConfig = {}) {
    this.facilitatorUrl = config.facilitatorUrl;
    this.useMock = config.mockCatalog ?? !config.facilitatorUrl;
  }

  async listServices(params?: { type?: 'http' | 'mcp' }): Promise<BazaarResource[]> {
    if (this.useMock) {
      const t = params?.type ?? 'http';
      return MOCK_CATALOG.filter((r) => r.type === t);
    }
    const url = `${this.facilitatorUrl}/discovery/resources${params?.type ? `?type=${params.type}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bazaar API error: ${res.status}`);
    const data = await res.json() as any;
    return data.items ?? data;
  }

  async search(query: string): Promise<BazaarSearchResult> {
    if (this.useMock) {
      const q = query.toLowerCase();
      const resources = MOCK_CATALOG.filter((r) =>
        r.description?.toLowerCase().includes(q) || r.resource.toLowerCase().includes(q)
      );
      return { resources, total: resources.length };
    }
    const url = `${this.facilitatorUrl}/discovery/resources/search`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) throw new Error(`Bazaar search error: ${res.status}`);
    return res.json() as Promise<BazaarSearchResult>;
  }
}

export function createBazaarClient(config?: BazaarClientConfig): BazaarClient {
  return new BazaarClient(config);
}
