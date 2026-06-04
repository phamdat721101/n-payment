import { NPaymentError } from '../errors.js';
import type { StellarSigner } from '../stellar/signer.js';
import type { StellarAssetSymbol } from '../stellar/assets.js';

/**
 * v0.21 — Stellar Anchor Directory off-ramp client (SEP-10 / SEP-24 / SEP-31).
 *
 * Closes the agent-earns-MGUSD → off-ramp-at-MoneyGram-retail loop. Distinct
 * class name (`StellarAnchorClient`) preserves the legacy `OffRampClient` export
 * for v0.20 callers.
 *
 * Design (SOLID):
 *   - SRP — anchor protocol orchestration only. KYC UX is delegated to the
 *           anchor's hosted `more_info_url`; SDK never collects PII.
 *   - DIP — depends on the abstract `AnchorRegistry` and `StellarSigner`,
 *           not on hard-coded anchor URLs or signing keys.
 *   - DRY — `sep10Auth` is the single SEP-10 implementation, reused by SEP-24
 *           today and (planned) SEP-31 in v0.22.
 */

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
}

export interface AnchorServiceUrls {
  transferServer?: string;       // SEP-24
  transferServerSep31?: string;  // SEP-31
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
 * Default v0.21 anchor list. MoneyGram listed first so MGUSD off-ramp queries
 * naturally surface it. Service URLs hydrated lazily via stellar.toml.
 *
 * The MoneyGram entry will hydrate against `https://moneygram.com/.well-known/stellar.toml`
 * once MoneyGram's anchor is registered with the Stellar Anchor Directory. Until then,
 * `findAnchor` returns the descriptor with empty `serviceUrls`, and `initiate` will
 * throw ANCHOR_TOML_INCOMPLETE — the recommended path is to set `STELLAR_ANCHOR_MONEYGRAM_TOML_URL`
 * env override (handled by `DefaultAnchorRegistry`) or supply a custom registry.
 */
const DEFAULT_ANCHORS: AnchorDescriptor[] = [
  {
    homeDomain: 'moneygram.com',
    name: 'MoneyGram',
    supportedAssets: ['MGUSD', 'USDC'],
    supportedFiat: ['USD', 'MXN', 'PHP', 'INR', 'NGN'],
    supportedCountries: ['US'],
    serviceUrls: {},
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
    this.defaults = defaults.map((a) => ({ ...a, serviceUrls: { ...a.serviceUrls } }));
  }

  add(d: AnchorDescriptor): void {
    this.custom.push({ ...d, serviceUrls: { ...d.serviceUrls } });
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
      const res = await fetch(tomlUrl);
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
    a.serviceUrls.webAuthEndpoint = get('WEB_AUTH_ENDPOINT');
    a.serviceUrls.kycServer = get('KYC_SERVER');
  }
}

// ─── OffRamp surface ────────────────────────────────────────────────────────

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
    const candidates = input.preferAnchor
      ? ([await this.registry.byDomain(input.preferAnchor)].filter(Boolean) as AnchorDescriptor[])
      : await this.registry.filter(input.asset, input.fiat, input.country);

    if (candidates.length === 0) {
      throw new NPaymentError(
        `No anchor supports off-ramp ${input.amount} ${input.asset} → ${input.fiat} in ${input.country}`,
        'OFFRAMP_NO_ANCHOR',
        'Try preferring a global-coverage anchor or check https://stellar.expert/explorer/directory.',
      );
    }

    const anchor = candidates[0];
    if (!anchor.serviceUrls.transferServer || !anchor.serviceUrls.webAuthEndpoint) {
      throw new NPaymentError(
        `Anchor ${anchor.name} stellar.toml missing TRANSFER_SERVER or WEB_AUTH_ENDPOINT`,
        'ANCHOR_TOML_INCOMPLETE',
        `Operator: set STELLAR_ANCHOR_${anchor.homeDomain.replace(/\./g, '_').toUpperCase()}_TOML_URL or wait for the anchor to publish its .toml.`,
      );
    }

    const isMainnet = input.isMainnet ?? true;
    const jwt = await this.sep10Auth(anchor, input.signer, isMainnet);

    const initRes = await fetch(`${anchor.serviceUrls.transferServer}/transactions/withdraw/interactive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_code: input.asset,
        amount: input.amount,
        account: input.signer.address,
      }),
    });
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
      status: () => this.pollStatus(anchor, jwt, data.id),
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
  ): Promise<OffRampHandle> {
    return this.initiate({ amount, asset, fiat, country, signer, isMainnet });
  }

  // ─── SEP-10 (DRY: single auth path used by SEP-24 today, SEP-31 next) ────

  private async sep10Auth(
    anchor: AnchorDescriptor,
    signer: StellarSigner,
    isMainnet: boolean,
  ): Promise<string> {
    const passphrase = isMainnet
      ? 'Public Global Stellar Network ; September 2015'
      : 'Test SDF Network ; September 2015';

    const challengeRes = await fetch(
      `${anchor.serviceUrls.webAuthEndpoint}?account=${encodeURIComponent(signer.address)}`,
    );
    if (!challengeRes.ok) {
      throw new NPaymentError(
        `SEP-10 challenge fetch failed: ${challengeRes.status}`,
        'ANCHOR_AUTH_FAILED',
      );
    }
    const { transaction } = (await challengeRes.json()) as { transaction: string };
    const signedXdr = await signer.signTransaction(transaction, passphrase);

    const tokenRes = await fetch(anchor.serviceUrls.webAuthEndpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: signedXdr }),
    });
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
  ): Promise<{ status: string; updatedAt: string; statusEta?: number }> {
    const res = await fetch(
      `${anchor.serviceUrls.transferServer}/transaction?id=${encodeURIComponent(txId)}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
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
