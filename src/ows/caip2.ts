/**
 * CAIP-2 → OWS chain-family resolver (single source of truth, pure functions).
 *
 * SOLID:
 *   • Single Responsibility — resolves namespace → family + derivation path.
 *   • Open-Closed — add a new chain family by appending one row to FAMILY_TABLE.
 *
 * Pure module — no I/O, no SDK imports, no side effects. Frozen table for
 * V8 hidden-class optimization.
 *
 * Spec: github.com/open-wallet-standard/core docs/07-supported-chains.md (v1.3.2).
 */

import { owsError } from '../errors.js';
import type { ChainFamily, FamilySpec } from './types.js';

/**
 * The 11 OWS chain families, frozen as the single source of truth.
 *
 * Adding a 12th family (e.g. Stellar in v0.28) = one row here +
 * one case in `cli-driver.ts:dispatchSign`. No edits elsewhere.
 */
export const FAMILY_TABLE: ReadonlyArray<FamilySpec> = Object.freeze([
  { family: 'evm',      namespace: 'eip155', curve: 'secp256k1', slip44: 60,      derivationTemplate: "m/44'/60'/0'/0/{i}",     addressFormat: 'EIP-55 hex' },
  { family: 'solana',   namespace: 'solana', curve: 'Ed25519',   slip44: 501,     derivationTemplate: "m/44'/501'/{i}'/0'",     addressFormat: 'base58 pubkey' },
  { family: 'bitcoin',  namespace: 'bip122', curve: 'secp256k1', slip44: 0,       derivationTemplate: "m/84'/0'/0'/0/{i}",      addressFormat: 'bech32 segwit' },
  { family: 'cosmos',   namespace: 'cosmos', curve: 'secp256k1', slip44: 118,     derivationTemplate: "m/44'/118'/0'/0/{i}",    addressFormat: 'bech32' },
  { family: 'tron',     namespace: 'tron',   curve: 'secp256k1', slip44: 195,     derivationTemplate: "m/44'/195'/0'/0/{i}",    addressFormat: 'base58check T...' },
  { family: 'ton',      namespace: 'ton',    curve: 'Ed25519',   slip44: 607,     derivationTemplate: "m/44'/607'/{i}'",        addressFormat: 'base64url v5r1' },
  { family: 'sui',      namespace: 'sui',    curve: 'Ed25519',   slip44: 784,     derivationTemplate: "m/44'/784'/{i}'/0'/0'",  addressFormat: '0x blake2b-256' },
  { family: 'xrpl',     namespace: 'xrpl',   curve: 'secp256k1', slip44: 144,     derivationTemplate: "m/44'/144'/0'/0/{i}",    addressFormat: 'base58check r...' },
  { family: 'spark',    namespace: 'spark',  curve: 'secp256k1', slip44: 8797555, derivationTemplate: "m/84'/0'/0'/0/{i}",      addressFormat: 'spark: + hex' },
  { family: 'filecoin', namespace: 'fil',    curve: 'secp256k1', slip44: 461,     derivationTemplate: "m/44'/461'/0'/0/{i}",    addressFormat: 'f1 base32' },
  { family: 'near',     namespace: 'near',   curve: 'Ed25519',   slip44: 397,     derivationTemplate: "m/44'/397'/{i}'",        addressFormat: '64-char hex' },
] as const);

/** O(1) namespace → spec lookup (built once at module load). */
const NAMESPACE_INDEX: ReadonlyMap<string, FamilySpec> = new Map(
  FAMILY_TABLE.map((spec) => [spec.namespace, spec]),
);

/** Parse a CAIP-2 string `<namespace>:<reference>`. Throws on malformed input. */
export function parseCaip2(caip2: string): { namespace: string; reference: string } {
  if (typeof caip2 !== 'string' || !caip2.includes(':')) {
    throw owsError('OWS_INVALID_CAIP2', `not a CAIP-2 string: ${String(caip2)}`);
  }
  const colonIndex = caip2.indexOf(':');
  const namespace = caip2.slice(0, colonIndex);
  const reference = caip2.slice(colonIndex + 1);
  if (!namespace || !reference) {
    throw owsError('OWS_INVALID_CAIP2', `missing namespace or reference: ${caip2}`);
  }
  return { namespace, reference };
}

/**
 * Resolve a CAIP-2 chain ID to its OWS family.
 * Throws `OWS_CHAIN_FAMILY_NOT_SUPPORTED` for namespaces outside the 11-family spec
 * (e.g. `stellar:*`, `aptos:*`).
 */
export function resolveFamily(caip2: string): ChainFamily {
  const { namespace } = parseCaip2(caip2);
  const spec = NAMESPACE_INDEX.get(namespace);
  if (!spec) {
    throw owsError('OWS_CHAIN_FAMILY_NOT_SUPPORTED', `namespace "${namespace}" not in OWS spec v1.3.2`);
  }
  return spec.family;
}

/** Return the full FamilySpec for a CAIP-2 chain. */
export function resolveSpec(caip2: string): FamilySpec {
  const { namespace } = parseCaip2(caip2);
  const spec = NAMESPACE_INDEX.get(namespace);
  if (!spec) {
    throw owsError('OWS_CHAIN_FAMILY_NOT_SUPPORTED', `namespace "${namespace}" not in OWS spec v1.3.2`);
  }
  return spec;
}

/** Render the BIP-32 derivation path for a family at a given account index. */
export function getDerivationPath(family: ChainFamily, index = 0): string {
  const spec = FAMILY_TABLE.find((f) => f.family === family);
  if (!spec) {
    throw owsError('OWS_CHAIN_FAMILY_NOT_SUPPORTED', `unknown family: ${family}`);
  }
  return spec.derivationTemplate.replace('{i}', String(index));
}

/** SLIP-44 coin type for a family. */
export function getSlip44(family: ChainFamily): number {
  const spec = FAMILY_TABLE.find((f) => f.family === family);
  if (!spec) {
    throw owsError('OWS_CHAIN_FAMILY_NOT_SUPPORTED', `unknown family: ${family}`);
  }
  return spec.slip44;
}

/**
 * Extract the EVM chainId number from a CAIP-2 of form `eip155:<n>`.
 * Returns `null` for non-EVM CAIP-2 strings (caller must dispatch differently).
 */
export function extractEvmChainId(caip2: string): number | null {
  const { namespace, reference } = parseCaip2(caip2);
  if (namespace !== 'eip155') return null;
  const n = Number.parseInt(reference, 10);
  return Number.isFinite(n) ? n : null;
}

/** All supported CAIP-2 namespaces (for error messages, docs, tests). */
export function listSupportedNamespaces(): readonly string[] {
  return FAMILY_TABLE.map((f) => f.namespace);
}
