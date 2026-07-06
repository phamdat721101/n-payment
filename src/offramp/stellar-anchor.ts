import { NPaymentError } from '../errors.js';
import type { StellarSigner } from '../stellar/signer.js';
import { assertVerifiedIssuer, getStellarAsset, type StellarAssetSymbol } from '../stellar/assets.js';

/**
 * v0.21 → v0.30 — Stellar Anchor Directory off-ramp client (SEP-10 / SEP-24 / SEP-31 / SEP-38).
 *
 * v0.21: SEP-10 auth + SEP-24 interactive withdraw client, DIP-friendly registry.
 * v0.30: SEP-38 quote() + SEP-31 b2bPayout() + stellarAgentKit() facade + testnet flag
 *        surfaced through facade opts. Byte-identical additive at the public surface.
 *
 * v0.30 additionally closes two v0.28 audit carryovers as side-effects:
 *   - SF-1 (fire-and-forget fetches) — every fetch in this module now flows through
 *     fetchWithTimeout with an AbortController and configurable timeoutMs.
 *   - SF-6 (default-on verified issuer) — assertVerifiedIssuer is pre-flighted at
 *     the entry of every value-moving method (initiate, quote, b2bPayout).
 *
 * SOLID:
 *   - SRP — one method per SEP; sep10Auth remains the only auth path.
 *   - OCP — quote() and b2bPayout() extend the existing class without touching
 *           the SEP-24 initiate() body.
 *   - DIP — depends on AnchorRegistry + StellarSigner abstractions.
 *   - DRY — sep10Auth serves SEP-24, SEP-31, and SEP-38 identically.
 */

// ─── Timeout-aware fetch helper (SF-1 closure) ──────────────────────────────

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Every fetch call in this module flows through this helper. Rejects with
 * NPaymentError('OFFRAMP_TIMEOUT', ...) when the anchor doesn't respond within
 * `ms`. Preserves any caller-supplied AbortSignal via signal composition.
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms: number = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const external = init.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error | undefined)?.name === 'AbortError') {
      let origin = url;
      try { origin = new URL(url).origin; } catch { /* keep url */ }
      throw new NPaymentError(
        `Anchor request timed out after ${ms}ms: ${url}`,
        'OFFRAMP_TIMEOUT',
        `Increase input.timeoutMs (currently ${ms}) or check anchor health at ${origin}.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Anchor descriptors ─────────────────────────────────────────────────────

export interface AnchorDescriptor {
  /** Anchor home_domain (e.g. 'moneygram.com'). */
  homeDomain: string;
  /** Display name for UX surfacing. */
  name: string;
  /** Stellar brand stables this anchor accepts. */
  supportedAssets: StellarAssetSymbol[];
  /** Fiat currencies this anchor pays out (e.g. ['USD','MXN']). */
  supportedFiat: string[];
  /** ISO country codes the anchor serves. 'GLOBAL' = no jurisdiction restriction. */
  supportedCountries: string[];
  /** Service URLs hydrated lazily from `<home_domain>/.well-known/stellar.toml`. */
  serviceUrls: AnchorServiceUrls;
  /**
   * v0.30 — Optional pre-computed corridor rows for LLM-prompt-friendly listing
   * via stellarAgentKit().corridors(). Anchors without this fall back to a
   * cartesian product of (supportedAssets × supportedFiat × supportedCountries).
   */
  supportedCorridors?: Array<{
    from: StellarAssetSymbol;
    to: string;            // ISO 4217 fiat code
    countries: string[];   // ISO 3166-1 alpha-2, or ['GLOBAL']
  }>;
}

export interface AnchorServiceUrls {
  transferServer?: string;       // SEP-24
  transferServerSep31?: string;  // SEP-31 (DIRECT_PAYMENT_SERVER)
  quoteServer?: string;          // v0.30 — SEP-38 (ANCHOR_QUOTE_SERVER)
  webAuthEndpoint?: string;      // SEP-10
  kycServer?: string;            // SEP-12
}

export interface AnchorRegistry {
  list(): Promise<AnchorDescriptor[]>;
  byDomain(homeDomain: string): Promise<AnchorDescriptor | null>;
  /** Filter to anchors that can off-ramp the given (asset, fiat, country) tuple. */
  filter(asset: StellarAssetSymbol, fiat: string, country: string): Promise<AnchorDescriptor[]>;
}

/**
 * Default v0.30 anchor list. MoneyGram listed first so MGUSD/USDC → USD queries
 * naturally surface it. Service URLs hydrated lazily via stellar.toml.
 *
 * NOTE (2026-07-06 grounding, PRD §Background): moneygram.com/.well-known/stellar.toml
 * publishes validators only — real MoneyGram Access anchor endpoints are allowlisted
 * per-wallet after MoneyGram onboarding. Operators point the SDK at their assigned
 * host (mainnet: previewstellar.moneygram.com; testnet: sandbox host) via
 * STELLAR_ANCHOR_MONEYGRAM_COM_TOML_URL env override — handled by DefaultAnchorRegistry.
 *
 * supportedCountries=['GLOBAL'] reflects MoneyGram's documented 174-country off-ramp
 * corridor (per developer.moneygram.com/ramps).
 */
const DEFAULT_ANCHORS: AnchorDescriptor[] = [
  {
    homeDomain: 'moneygram.com',
    name: 'MoneyGram Access',
    supportedAssets: ['USDC', 'MGUSD'],
    supportedFiat: ['USD', 'MXN', 'PHP', 'INR', 'NGN', 'EUR', 'GBP', 'BRL'],
    supportedCountries: ['GLOBAL'],
    serviceUrls: {},
    supportedCorridors: [
      { from: 'USDC', to: 'USD', countries: ['GLOBAL'] },
      { from: 'MGUSD', to: 'USD', countries: ['GLOBAL'] },
    ],
  },
  {
    homeDomain: 'vibrantapp.com',
    name: 'Vibrant',
    supportedAssets: ['USDC', 'EURC'],
    supportedFiat: ['USD', 'ARS', 'BRL'],
    supportedCountries: ['AR', 'BR', 'US'],
    serviceUrls: {},
  },
  {
    homeDomain: 'lobstr.co',
    name: 'LOBSTR',
    supportedAssets: ['USDC', 'EURC'],
    supportedFiat: ['USD', 'EUR'],
    supportedCountries: ['EU'],
    serviceUrls: {},
  },
];

export class DefaultAnchorRegistry implements AnchorRegistry {
  private readonly defaults: AnchorDescriptor[];
  private readonly custom: AnchorDescriptor[] = [];

  constructor(defaults: AnchorDescriptor[] = DEFAULT_ANCHORS) {
    // Deep-copy so external mutation can't poison the registry.
    this.defaults = defaults.map((a) => ({
      ...a,
      serviceUrls: { ...a.serviceUrls },
      supportedCorridors: a.supportedCorridors?.map((c) => ({ ...c, countries: [...c.countries] })),
    }));
  }

  add(d: AnchorDescriptor): void {
    this.custom.push({
      ...d,
      serviceUrls: { ...d.serviceUrls },
      supportedCorridors: d.supportedCorridors?.map((c) => ({ ...c, countries: [...c.countries] })),
    });
  }

  async list(): Promise<AnchorDescriptor[]> {
    return [...this.defaults, ...this.custom];
  }

  async byDomain(homeDomain: string): Promise<AnchorDescriptor | null> {
    const all = await this.list();
    const found = all.find((a) => a.homeDomain === homeDomain) ?? null;
    if (found) await this.hydrateServiceUrls(found);
    return found;
  }

  async filter(
    asset: StellarAssetSymbol,
    fiat: string,
    country: string,
  ): Promise<AnchorDescriptor[]> {
    const all = await this.list();
    const matches = all.filter(
      (a) =>
        a.supportedAssets.includes(asset) &&
        a.supportedFiat.includes(fiat) &&
        (a.supportedCountries.includes(country) || a.supportedCountries.includes('GLOBAL')),
    );
    for (const m of matches) await this.hydrateServiceUrls(m);
    return matches;
  }

  /** Fetch and parse `<home_domain>/.well-known/stellar.toml`. Idempotent — skips if hydrated. */
  private async hydrateServiceUrls(a: AnchorDescriptor): Promise<void> {
    if (a.serviceUrls.transferServer || a.serviceUrls.transferServerSep31) return;

    const tomlUrl =
      process.env[`STELLAR_ANCHOR_${a.homeDomain.replace(/\./g, '_').toUpperCase()}_TOML_URL`] ??
      `https://${a.homeDomain}/.well-known/stellar.toml`;

    let toml: string;
    try {
      const res = await fetchWithTimeout(tomlUrl, {});
      if (!res.ok) {
        throw new NPaymentError(
          `stellar.toml fetch failed for ${a.homeDomain}: ${res.status}`,
          'ANCHOR_TOML_FETCH_FAILED',
        );
      }
      toml = await res.text();
    } catch (err) {
      if (err instanceof NPaymentError) throw err;
      throw new NPaymentError(
        `stellar.toml fetch failed for ${a.homeDomain}: ${(err as Error).message}`,
        'ANCHOR_TOML_FETCH_FAILED',
      );
    }

    const get = (k: string): string | undefined => {
      const m = toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm'));
      return m?.[1];
    };
    a.serviceUrls.transferServer = get('TRANSFER_SERVER') ?? get('TRANSFER_SERVER_SEP0024');
    a.serviceUrls.transferServerSep31 = get('DIRECT_PAYMENT_SERVER');
    a.serviceUrls.quoteServer = get('ANCHOR_QUOTE_SERVER');
    a.serviceUrls.webAuthEndpoint = get('WEB_AUTH_ENDPOINT');
    a.serviceUrls.kycServer = get('KYC_SERVER');
  }
}

// ─── OffRamp surface (SEP-24) ───────────────────────────────────────────────

export interface OffRampInitiateInput {
  asset: StellarAssetSymbol;
  amount: string;          // decimal display string
  fiat: string;            // ISO code, e.g. 'USD'
  country: string;         // ISO 3166-1 alpha-2
  signer: StellarSigner;
  /** Stellar mainnet (true) vs testnet (false). Default: true. */
  isMainnet?: boolean;
  /** Force a specific anchor by home_domain (skips filter). */
  preferAnchor?: string;
  /** v0.30 — per-request timeout in ms (default 12000). */
  timeoutMs?: number;
}

export interface OffRampHandle {
  /** Anchor's transaction id (opaque). */
  transactionId: string;
  /** Anchor's hosted URL — open in browser/webview to complete KYC + payout instructions. */
  moreInfoUrl: string;
  /** Descriptor of the anchor used. */
  anchor: AnchorDescriptor;
  /** Poll the anchor's `/transaction` endpoint for the latest status. */
  status(): Promise<{ status: string; updatedAt: string; statusEta?: number }>;
}

// ─── v0.30 — SEP-38 quote surface ───────────────────────────────────────────

export interface OffRampQuoteInput {
  asset: StellarAssetSymbol;
  amount: string;               // sell amount, decimal display
  fiat: string;
  country: string;
  signer: StellarSigner;
  isMainnet?: boolean;
  preferAnchor?: string;
  timeoutMs?: number;
}

export interface OffRampQuoteResult {
  /** Price of 1 unit asset expressed in fiat (decimal display). */
  rate: string;
  /** RFC-3339 timestamp after which the quote is no longer honored. */
  expiresAt: string;
  /** Fixed fee in asset units (decimal display), if any. */
  feeFixed?: string;
  /** Percent fee (decimal display), if any. */
  feePercent?: string;
  /** Opaque quote id — can be passed into b2bPayout via `quoteId`. */
  quoteId?: string;
  /** The anchor used. */
  anchor: AnchorDescriptor;
}

// ─── v0.30 — SEP-31 b2bPayout surface ───────────────────────────────────────

export interface OffRampB2BInput {
  asset: StellarAssetSymbol;
  amount: string;
  fiat: string;
  country: string;
  signer: StellarSigner;
  isMainnet?: boolean;
  preferAnchor?: string;
  timeoutMs?: number;
  /** Optional linkage to a prior SEP-38 quote (recommended for fee-locked flows). */
  quoteId?: string;
  /** Pre-registered SEP-12 receiver id. If absent, receiverInfoUrl is returned for out-of-band registration. */
  receiverId?: string;
  /** SEP-9 KYC fields the anchor requires (see anchor docs for exact set). */
  fields?: Record<string, string>;
}

export interface OffRampB2BHandle extends OffRampHandle {
  /** Anchor-hosted URL for SEP-12 receiver registration when receiverId is absent or unrecognised. */
  receiverInfoUrl: string;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class StellarAnchorClient {
  constructor(private readonly registry: AnchorRegistry = new DefaultAnchorRegistry()) {}

  /** Find anchors capable of (asset, fiat, country). */
  async findAnchor(
    asset: StellarAssetSymbol,
    fiat: string,
    country: string,
  ): Promise<AnchorDescriptor[]> {
    return this.registry.filter(asset, fiat, country);
  }

  /** Initiate an SEP-24 interactive withdraw and return a handle for status polling. */
  async initiate(input: OffRampInitiateInput): Promise<OffRampHandle> {
    // v0.30 — SF-6 closure: verified-issuer pre-flight before any value moves.
    assertVerifiedIssuer(getStellarAsset(input.asset));

    const anchor = await this.selectAnchor(input);
    if (!anchor.serviceUrls.transferServer || !anchor.serviceUrls.webAuthEndpoint) {
      throw new NPaymentError(
        `Anchor ${anchor.name} stellar.toml missing TRANSFER_SERVER or WEB_AUTH_ENDPOINT`,
        'ANCHOR_TOML_INCOMPLETE',
        `Operator: set STELLAR_ANCHOR_${anchor.homeDomain.replace(/\./g, '_').toUpperCase()}_TOML_URL or wait for the anchor to publish its .toml.`,
      );
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const isMainnet = input.isMainnet ?? true;
    const jwt = await this.sep10Auth(anchor, input.signer, isMainnet, timeoutMs);

    const initRes = await fetchWithTimeout(
      `${anchor.serviceUrls.transferServer}/transactions/withdraw/interactive`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset_code: input.asset,
          amount: input.amount,
          account: input.signer.address,
        }),
      },
      timeoutMs,
    );
    if (!initRes.ok) {
      throw new NPaymentError(
        `SEP-24 withdraw initiate failed: ${initRes.status} ${initRes.statusText}`,
        'OFFRAMP_INITIATE_FAILED',
      );
    }
    const data = (await initRes.json()) as { id: string; url: string };

    return {
      transactionId: data.id,
      moreInfoUrl: data.url,
      anchor,
      status: () => this.pollStatus(anchor, jwt, data.id, timeoutMs),
    };
  }

  /**
   * v0.30 — SEP-38 pre-flight quote. Returns the anchor's current rate + fee
   * + expiresAt + opaque quoteId that b2bPayout can reference.
   */
  async quote(input: OffRampQuoteInput): Promise<OffRampQuoteResult> {
    assertVerifiedIssuer(getStellarAsset(input.asset));

    const anchor = await this.selectAnchor(input);
    if (!anchor.serviceUrls.quoteServer || !anchor.serviceUrls.webAuthEndpoint) {
      throw new NPaymentError(
        `Anchor ${anchor.name} does not publish ANCHOR_QUOTE_SERVER`,
        'ANCHOR_QUOTE_NOT_SUPPORTED',
        `Anchor's stellar.toml declares no ANCHOR_QUOTE_SERVER — SEP-38 not offered. Fall back to client.cashOut() directly.`,
      );
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const isMainnet = input.isMainnet ?? true;
    const jwt = await this.sep10Auth(anchor, input.signer, isMainnet, timeoutMs);

    const asset = getStellarAsset(input.asset);
    const sellAsset = `stellar:${asset.code}:${asset.issuer}`;
    const buyAsset = `iso4217:${input.fiat}`;
    const qs = new URLSearchParams({
      sell_asset: sellAsset,
      buy_asset: buyAsset,
      sell_amount: input.amount,
      country_code: input.country,
    });

    const res = await fetchWithTimeout(
      `${anchor.serviceUrls.quoteServer}/price?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
      timeoutMs,
    );
    if (!res.ok) {
      throw new NPaymentError(
        `SEP-38 quote failed: ${res.status} ${res.statusText}`,
        'OFFRAMP_QUOTE_FAILED',
        `Anchor rejected the quote request. Check corridor availability at ${anchor.homeDomain} or fall back to a different anchor.`,
      );
    }
    const data = (await res.json()) as {
      price?: string;
      expires_at?: string;
      fee?: { total?: string; percent?: string; asset?: string };
      id?: string;
    };

    return {
      rate: data.price ?? '',
      expiresAt: data.expires_at ?? '',
      feeFixed: data.fee?.total,
      feePercent: data.fee?.percent,
      quoteId: data.id,
      anchor,
    };
  }

  /**
   * v0.30 — SEP-31 direct-payment for A2A / B2A commerce. Sender agent posts
   * the payment intent; anchor returns receiver-info-url for SEP-12 registration
   * (if the receiver_id is unknown) plus the sender-side Stellar Payment target.
   * Handle exposes the same status() shape as SEP-24.
   */
  async b2bPayout(input: OffRampB2BInput): Promise<OffRampB2BHandle> {
    assertVerifiedIssuer(getStellarAsset(input.asset));

    const anchor = await this.selectAnchor(input);
    if (!anchor.serviceUrls.transferServerSep31 || !anchor.serviceUrls.webAuthEndpoint) {
      throw new NPaymentError(
        `Anchor ${anchor.name} does not publish DIRECT_PAYMENT_SERVER`,
        'ANCHOR_B2B_NOT_SUPPORTED',
        `Anchor's stellar.toml declares no DIRECT_PAYMENT_SERVER — SEP-31 not offered. Fall back to client.cashOut() to reach the receiver via the interactive path.`,
      );
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const isMainnet = input.isMainnet ?? true;
    const jwt = await this.sep10Auth(anchor, input.signer, isMainnet, timeoutMs);

    const body: Record<string, unknown> = {
      amount: input.amount,
      asset_code: input.asset,
      sender_account: input.signer.address,
    };
    if (input.receiverId) body.receiver_id = input.receiverId;
    if (input.quoteId) body.quote_id = input.quoteId;
    if (input.fields) body.fields = input.fields;

    const res = await fetchWithTimeout(
      `${anchor.serviceUrls.transferServerSep31}/transactions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
    if (!res.ok) {
      throw new NPaymentError(
        `SEP-31 direct-payment failed: ${res.status} ${res.statusText}`,
        'OFFRAMP_B2B_FAILED',
        `Anchor rejected the direct-payment request. If the receiver is not yet registered, register via the anchor's SEP-12 KYC server (${anchor.serviceUrls.kycServer ?? '<not-declared>'}).`,
      );
    }
    const data = (await res.json()) as {
      id: string;
      stellar_account_id?: string;
      stellar_memo?: string;
      stellar_memo_type?: string;
      receiver_info_url?: string;
    };

    return {
      transactionId: data.id,
      moreInfoUrl: data.receiver_info_url ?? '',
      receiverInfoUrl: data.receiver_info_url ?? '',
      anchor,
      status: () => this.pollStatus(anchor, jwt, data.id, timeoutMs),
    };
  }

  /** Convenience wrapper for the cash-out flow. Defaults country to 'US'. */
  async cashOut(
    amount: string,
    asset: StellarAssetSymbol,
    fiat: string,
    signer: StellarSigner,
    country = 'US',
    isMainnet = true,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<OffRampHandle> {
    return this.initiate({ amount, asset, fiat, country, signer, isMainnet, timeoutMs });
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  private async selectAnchor(input: {
    asset: StellarAssetSymbol;
    fiat: string;
    country: string;
    amount: string;
    preferAnchor?: string;
  }): Promise<AnchorDescriptor> {
    const candidates = input.preferAnchor
      ? ([await this.registry.byDomain(input.preferAnchor)].filter(Boolean) as AnchorDescriptor[])
      : await this.registry.filter(input.asset, input.fiat, input.country);

    if (candidates.length === 0) {
      throw new NPaymentError(
        `No anchor supports ${input.amount} ${input.asset} → ${input.fiat} in ${input.country}`,
        'OFFRAMP_NO_ANCHOR',
        'Try preferring a global-coverage anchor or check https://stellar.expert/explorer/directory.',
      );
    }
    return candidates[0];
  }

  private async sep10Auth(
    anchor: AnchorDescriptor,
    signer: StellarSigner,
    isMainnet: boolean,
    timeoutMs: number,
  ): Promise<string> {
    const passphrase = isMainnet
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';

    const challengeRes = await fetchWithTimeout(
      `${anchor.serviceUrls.webAuthEndpoint}?account=${encodeURIComponent(signer.address)}`,
      {},
      timeoutMs,
    );
    if (!challengeRes.ok) {
      throw new NPaymentError(
        `SEP-10 challenge fetch failed: ${challengeRes.status}`,
        'ANCHOR_AUTH_FAILED',
      );
    }
    const { transaction } = (await challengeRes.json()) as { transaction: string };
    const signedXdr = await signer.signTransaction(transaction, passphrase);

    const tokenRes = await fetchWithTimeout(
      anchor.serviceUrls.webAuthEndpoint!,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: signedXdr }),
      },
      timeoutMs,
    );
    if (!tokenRes.ok) {
      throw new NPaymentError(
        `SEP-10 token exchange failed: ${tokenRes.status}`,
        'ANCHOR_AUTH_FAILED',
      );
    }
    return ((await tokenRes.json()) as { token: string }).token;
  }

  private async pollStatus(
    anchor: AnchorDescriptor,
    jwt: string,
    txId: string,
    timeoutMs: number,
  ): Promise<{ status: string; updatedAt: string; statusEta?: number }> {
    const res = await fetchWithTimeout(
      `${anchor.serviceUrls.transferServer}/transaction?id=${encodeURIComponent(txId)}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
      timeoutMs,
    );
    if (!res.ok) {
      throw new NPaymentError(
        `Status poll failed: ${res.status}`,
        'OFFRAMP_POLL_FAILED',
      );
    }
    const { transaction } = (await res.json()) as {
      transaction: { status: string; updatedAt?: string; updated_at?: string; status_eta?: number };
    };
    return {
      status: transaction.status,
      updatedAt: transaction.updatedAt ?? transaction.updated_at ?? '',
      statusEta: transaction.status_eta,
    };
  }
}

// ─── v0.30 — stellarAgentKit facade ──────────────────────────────────────────

/**
 * One-line agent-facing surface. Returns a bound-methods object closing over a
 * private StellarAnchorClient. isMainnet defaults to true; set to false to run
 * against Stellar testnet (SEP-10 passphrase flips automatically).
 *
 * Shape is intentionally verb-oriented + LLM-prompt-friendly: cashOut / quote /
 * b2bPayout / corridors / status. No SEP terminology surfaces to the caller.
 */
export function stellarAgentKit(
  signer: StellarSigner,
  opts: {
    registry?: AnchorRegistry;
    isMainnet?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const registry = opts.registry ?? new DefaultAnchorRegistry();
  const client = new StellarAnchorClient(registry);
  const isMainnet = opts.isMainnet ?? true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Corridors are stable per registry instance → cache first-call result.
  let corridorsCache: Array<{ anchor: string; from: string; to: string; countries: string[] }> | null = null;

  return {
    async cashOut(
      amount: string,
      asset: StellarAssetSymbol,
      fiat: string,
      country = 'US',
    ): Promise<OffRampHandle> {
      return client.cashOut(amount, asset, fiat, signer, country, isMainnet, timeoutMs);
    },

    async quote(
      input: Omit<OffRampQuoteInput, 'signer' | 'isMainnet' | 'timeoutMs'>,
    ): Promise<OffRampQuoteResult> {
      return client.quote({ ...input, signer, isMainnet, timeoutMs });
    },

    async b2bPayout(
      input: Omit<OffRampB2BInput, 'signer' | 'isMainnet' | 'timeoutMs'>,
    ): Promise<OffRampB2BHandle> {
      return client.b2bPayout({ ...input, signer, isMainnet, timeoutMs });
    },

    async corridors(): Promise<Array<{ anchor: string; from: string; to: string; countries: string[] }>> {
      if (corridorsCache) return corridorsCache;
      const anchors = await registry.list();
      const rows: Array<{ anchor: string; from: string; to: string; countries: string[] }> = [];
      for (const a of anchors) {
        if (a.supportedCorridors && a.supportedCorridors.length > 0) {
          for (const c of a.supportedCorridors) {
            rows.push({ anchor: a.name, from: c.from, to: c.to, countries: [...c.countries] });
          }
        } else {
          // Fall back to (asset × fiat) product; countries are the anchor's declared set.
          for (const from of a.supportedAssets) {
            for (const to of a.supportedFiat) {
              rows.push({ anchor: a.name, from, to, countries: [...a.supportedCountries] });
            }
          }
        }
      }
      corridorsCache = rows;
      return rows;
    },

    status(handle: OffRampHandle | OffRampB2BHandle) {
      return handle.status();
    },
  };
}
