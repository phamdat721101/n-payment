import { NPaymentError } from '../errors.js';

/**
 * v0.21 — KYA-tier gate primitive.
 *
 * Server-side `StellarKyaGate` middleware checks endpoint access by Know-Your-Agent
 * tier (ERC-8004 + Skyfire-compatible). Buyer-side `StellarKyaCredentialFetcher`
 * pulls a fresh signed credential and base64-encodes it for the `x-kya-credential`
 * request header. Bare-gate by design: caller supplies the oracle URL — no oracle
 * infra ships in this repo.
 *
 * Design (SOLID):
 *   - SRP — verification + fetch only.
 *   - DIP — `StellarKyaGate` depends on a canonical-body verifier, not on a
 *           specific oracle URL or transport.
 *   - DRY — `canonicalCredentialBytes` is the single source of the
 *           sign-and-verify byte layout (used by both sides).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KyaCredential {
  /** Agent's Stellar G... address. */
  agentAddress: string;
  /** ERC-8004 reputation reading at issue time (0-100). */
  reputationScore: number;
  /** KYA tier (0=anon, 1=email, 2=KYC-light, 3=KYC-full). */
  kyaTier: number;
  /** ISO timestamp when the credential was issued. */
  issuedAt: string;
  /** ISO timestamp when the credential expires. */
  validUntil: string;
  /** Issuing oracle's identifier (e.g. 'erc8004:base:0x…'). */
  issuer: string;
  /** Base64-encoded ed25519 signature over canonical body bytes. */
  signature: string;
}

export interface KyaGateConfig {
  /** Minimum KYA tier required to access the gated endpoint. */
  minKyaTier: number;
  /** Optional pubkey of the trusted oracle issuer (G... 56-char). Defaults to env STELLAR_KYA_ORACLE_PUBKEY. */
  trustedIssuerPubkey?: string;
  /** Max age of the credential (ms). Default 5 minutes. */
  maxAgeMs?: number;
}

// Minimal Express-compatible types, declared inline so this module has no `express` dep.
type ExpressReq = { header(name: string): string | undefined } & Record<string, unknown>;
type ExpressRes = {
  status(code: number): ExpressRes;
  json(body: unknown): ExpressRes;
};
type ExpressNext = (err?: unknown) => void;

// ─── Canonical bytes helper (DRY: single source of sign+verify byte layout) ─

/**
 * Canonical JSON of the credential body (excluding signature), with sorted keys.
 * Both the issuing oracle and the verifying gate must produce identical bytes.
 */
export function canonicalCredentialBytes(cred: KyaCredential): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _drop, ...body } = cred;
  const sorted = Object.keys(body)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (body as Record<string, unknown>)[k];
      return acc;
    }, {});
  return new TextEncoder().encode(JSON.stringify(sorted));
}

// ─── Server middleware ──────────────────────────────────────────────────────

const FIVE_MIN_MS = 5 * 60 * 1000;

export class StellarKyaGate {
  private sdkPromise?: Promise<unknown>;

  constructor(private readonly config: KyaGateConfig) {}

  /**
   * Express middleware: rejects requests below `minKyaTier` or with invalid signature.
   * On success, attaches the verified credential to `req.kya` for downstream handlers.
   */
  middleware() {
    return async (req: ExpressReq, res: ExpressRes, next: ExpressNext): Promise<void> => {
      const header = req.header('x-kya-credential');
      if (!header) {
        res.status(402).json({
          error: 'KYA credential required',
          kya_required: true,
          min_kya_tier: this.config.minKyaTier,
          hint: 'Attach `x-kya-credential` header (base64 of signed JSON). See https://n-payment.dev/docs/kya',
        });
        return;
      }

      let cred: KyaCredential;
      try {
        cred = JSON.parse(Buffer.from(header, 'base64').toString());
      } catch {
        res.status(400).json({ error: 'Malformed KYA credential', code: 'KYA_BAD_CREDENTIAL' });
        return;
      }

      const verdict = await this.verify(cred);
      if (!verdict.valid) {
        res.status(403).json({ error: `KYA gate rejected: ${verdict.reason}` });
        return;
      }

      (req as Record<string, unknown>).kya = cred;
      next();
    };
  }

  /** Programmatic verifier — same logic as middleware, returned as a discriminated result. */
  async verify(cred: KyaCredential): Promise<{ valid: true } | { valid: false; reason: string }> {
    if (cred.kyaTier < this.config.minKyaTier) {
      return { valid: false, reason: `tier ${cred.kyaTier} < required ${this.config.minKyaTier}` };
    }
    const now = Date.now();
    const issuedAtMs = Date.parse(cred.issuedAt);
    if (Number.isNaN(issuedAtMs)) return { valid: false, reason: 'malformed issuedAt' };
    const age = now - issuedAtMs;
    const maxAge = this.config.maxAgeMs ?? FIVE_MIN_MS;
    if (age > maxAge) return { valid: false, reason: `credential too old: ${age}ms > ${maxAge}ms` };
    const validUntilMs = Date.parse(cred.validUntil);
    if (Number.isNaN(validUntilMs)) return { valid: false, reason: 'malformed validUntil' };
    if (now > validUntilMs) return { valid: false, reason: 'credential expired' };

    const issuerPubkey = this.config.trustedIssuerPubkey ?? process.env.STELLAR_KYA_ORACLE_PUBKEY;
    if (!issuerPubkey) {
      throw new NPaymentError(
        'No trustedIssuerPubkey configured',
        'KYA_NO_ISSUER',
        'Set STELLAR_KYA_ORACLE_PUBKEY env or pass trustedIssuerPubkey in KyaGateConfig.',
      );
    }
    const ok = await this.verifySignature(cred, issuerPubkey);
    return ok ? { valid: true } : { valid: false, reason: 'invalid signature' };
  }

  private async verifySignature(cred: KyaCredential, issuerPubkey: string): Promise<boolean> {
    const sdk = (await this.loadSdk()) as { Keypair: { fromPublicKey(p: string): { verify(msg: Buffer, sig: Buffer): boolean } } };
    const pubkey = sdk.Keypair.fromPublicKey(issuerPubkey);
    return pubkey.verify(Buffer.from(canonicalCredentialBytes(cred)), Buffer.from(cred.signature, 'base64'));
  }

  private loadSdk(): Promise<unknown> {
    if (!this.sdkPromise) {
      this.sdkPromise = import('@stellar/stellar-sdk').catch(() => {
        throw new NPaymentError(
          '@stellar/stellar-sdk peer dependency not installed',
          'STELLAR_SDK_MISSING',
          'Install: npm install @stellar/stellar-sdk',
        );
      });
    }
    return this.sdkPromise;
  }
}

// ─── Buyer-side credential fetcher ──────────────────────────────────────────

export class StellarKyaCredentialFetcher {
  constructor(private readonly oracleUrl: string, private readonly apiKey?: string) {}

  /** Request a fresh credential from the off-chain ERC-8004 oracle for the given agent address. */
  async fetch(agentAddress: string): Promise<KyaCredential> {
    const url = `${this.oracleUrl.replace(/\/$/, '')}/credentials/${encodeURIComponent(agentAddress)}`;
    const res = await fetch(url, {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined,
    });
    if (!res.ok) {
      throw new NPaymentError(
        `KYA oracle credential fetch failed: ${res.status} ${res.statusText}`,
        'KYA_ORACLE_FETCH_FAILED',
        `Verify oracle URL + API key. URL: ${url}`,
      );
    }
    return (await res.json()) as KyaCredential;
  }

  /** Encode a credential as the canonical base64 header value. */
  static encodeHeader(cred: KyaCredential): string {
    return Buffer.from(JSON.stringify(cred)).toString('base64');
  }

  /** Decode a header value back to a credential (utility for tests + adapters). */
  static decodeHeader(header: string): KyaCredential {
    return JSON.parse(Buffer.from(header, 'base64').toString());
  }
}

// ─── Adapter helper (DRY: single attach-on-retry path used by all 3 adapters) ─

/**
 * If the 402 challenge declares `kya_required: true`, fetch a credential and
 * attach `x-kya-credential` to the headers map. No-op when not required.
 *
 * Throws KYA_NOT_CONFIGURED if required but no fetcher is supplied.
 */
export async function attachKyaIfRequired(
  headers: Headers,
  challenge: { kya_required?: boolean } | undefined,
  fetcher: StellarKyaCredentialFetcher | undefined,
  agentAddress: string,
): Promise<void> {
  if (!challenge?.kya_required) return;
  if (!fetcher) {
    throw new NPaymentError(
      'Endpoint requires KYA but no kyaFetcher configured',
      'KYA_NOT_CONFIGURED',
      'Pass kyaFetcher: new StellarKyaCredentialFetcher(oracleUrl) to the adapter constructor.',
    );
  }
  const cred = await fetcher.fetch(agentAddress);
  headers.set('x-kya-credential', StellarKyaCredentialFetcher.encodeHeader(cred));
}
