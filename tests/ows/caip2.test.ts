/**
 * Unit tests for the pure CAIP-2 resolver.
 *
 * No SDK dependency. Tests cover:
 *   • round-trip namespace ↔ family across all 11 OWS chain families
 *   • derivation-path templates match OWS spec v1.3.2 exactly
 *   • SLIP-44 coin types are correct
 *   • non-OWS namespaces (Stellar, Aptos, etc.) reject with OWS_CHAIN_FAMILY_NOT_SUPPORTED
 *   • malformed CAIP-2 strings reject with OWS_INVALID_CAIP2
 *   • EVM chainId extraction works for valid eip155 strings, returns null otherwise
 */
import { describe, it, expect } from 'vitest';
import {
  FAMILY_TABLE,
  parseCaip2,
  resolveFamily,
  resolveSpec,
  getDerivationPath,
  getSlip44,
  extractEvmChainId,
  listSupportedNamespaces,
} from '../../src/ows/caip2.js';
import { NPaymentError } from '../../src/errors.js';

describe('caip2 — FAMILY_TABLE', () => {
  it('has exactly 11 OWS chain families', () => {
    expect(FAMILY_TABLE).toHaveLength(11);
  });

  it('every row has all required fields', () => {
    for (const spec of FAMILY_TABLE) {
      expect(spec.family).toBeTruthy();
      expect(spec.namespace).toBeTruthy();
      expect(spec.curve).toMatch(/^(secp256k1|Ed25519)$/);
      expect(spec.slip44).toBeGreaterThanOrEqual(0);
      expect(spec.derivationTemplate).toContain("'");
      expect(spec.addressFormat).toBeTruthy();
    }
  });

  it('FAMILY_TABLE is frozen (Open-Closed enforcement)', () => {
    expect(Object.isFrozen(FAMILY_TABLE)).toBe(true);
  });

  it('listSupportedNamespaces matches FAMILY_TABLE namespaces', () => {
    expect(listSupportedNamespaces()).toEqual(FAMILY_TABLE.map((f) => f.namespace));
  });
});

describe('caip2 — parseCaip2', () => {
  it('parses a valid CAIP-2 string', () => {
    expect(parseCaip2('eip155:8453')).toEqual({ namespace: 'eip155', reference: '8453' });
    expect(parseCaip2('xrpl:mainnet')).toEqual({ namespace: 'xrpl', reference: 'mainnet' });
    expect(parseCaip2('cosmos:interwoven-1')).toEqual({ namespace: 'cosmos', reference: 'interwoven-1' });
  });

  it('rejects non-string input', () => {
    expect(() => parseCaip2(123 as unknown as string)).toThrow(NPaymentError);
    expect(() => parseCaip2(undefined as unknown as string)).toThrow(NPaymentError);
  });

  it('rejects strings without colon', () => {
    expect(() => parseCaip2('eip155')).toThrow(/OWS_INVALID_CAIP2/);
  });

  it('rejects empty namespace or reference', () => {
    expect(() => parseCaip2(':8453')).toThrow(/OWS_INVALID_CAIP2/);
    expect(() => parseCaip2('eip155:')).toThrow(/OWS_INVALID_CAIP2/);
  });
});

describe('caip2 — resolveFamily / resolveSpec', () => {
  const cases = [
    ['eip155:8453', 'evm'],
    ['eip155:1', 'evm'],
    ['solana:mainnet', 'solana'],
    ['xrpl:mainnet', 'xrpl'],
    ['xrpl:testnet', 'xrpl'],
    ['cosmos:interwoven-1', 'cosmos'],
    ['bip122:000000000019d6689c085ae165831e93', 'bitcoin'],
    ['sui:mainnet', 'sui'],
    ['tron:mainnet', 'tron'],
    ['ton:mainnet', 'ton'],
    ['spark:mainnet', 'spark'],
    ['fil:mainnet', 'filecoin'],
    ['near:mainnet', 'near'],
    ['near:testnet', 'near'],
  ] as const;

  for (const [caip2, expected] of cases) {
    it(`resolves ${caip2} → ${expected}`, () => {
      expect(resolveFamily(caip2)).toBe(expected);
      expect(resolveSpec(caip2).family).toBe(expected);
    });
  }

  it('rejects Stellar (not in OWS spec v1.3.2)', () => {
    expect(() => resolveFamily('stellar:pubnet')).toThrow(/OWS_CHAIN_FAMILY_NOT_SUPPORTED/);
  });

  it('rejects Aptos (not in OWS spec)', () => {
    expect(() => resolveFamily('aptos:mainnet')).toThrow(/OWS_CHAIN_FAMILY_NOT_SUPPORTED/);
  });
});

describe('caip2 — getDerivationPath', () => {
  it('renders SLIP-44 template for EVM', () => {
    expect(getDerivationPath('evm', 0)).toBe("m/44'/60'/0'/0/0");
    expect(getDerivationPath('evm', 5)).toBe("m/44'/60'/0'/0/5");
  });

  it('renders Solana hardened-account path', () => {
    expect(getDerivationPath('solana', 0)).toBe("m/44'/501'/0'/0'");
    expect(getDerivationPath('solana', 3)).toBe("m/44'/501'/3'/0'");
  });

  it('renders XRPL path', () => {
    expect(getDerivationPath('xrpl', 0)).toBe("m/44'/144'/0'/0/0");
  });

  it('renders Sui hardened path', () => {
    expect(getDerivationPath('sui', 0)).toBe("m/44'/784'/0'/0'/0'");
  });

  it('defaults index to 0', () => {
    expect(getDerivationPath('cosmos')).toBe("m/44'/118'/0'/0/0");
  });
});

describe('caip2 — getSlip44', () => {
  const expected: Record<string, number> = {
    evm: 60, solana: 501, bitcoin: 0, cosmos: 118,
    tron: 195, ton: 607, sui: 784, xrpl: 144,
    spark: 8797555, filecoin: 461, near: 397,
  };
  for (const [family, slip44] of Object.entries(expected)) {
    it(`${family} → ${slip44}`, () => {
      expect(getSlip44(family as never)).toBe(slip44);
    });
  }
});

describe('caip2 — extractEvmChainId', () => {
  it('extracts numeric chainId from eip155 strings', () => {
    expect(extractEvmChainId('eip155:1')).toBe(1);
    expect(extractEvmChainId('eip155:8453')).toBe(8453);
    expect(extractEvmChainId('eip155:84532')).toBe(84532);
  });

  it('returns null for non-EVM CAIP-2', () => {
    expect(extractEvmChainId('xrpl:mainnet')).toBeNull();
    expect(extractEvmChainId('solana:mainnet')).toBeNull();
    expect(extractEvmChainId('cosmos:interwoven-1')).toBeNull();
  });

  it('returns null for malformed eip155 reference', () => {
    expect(extractEvmChainId('eip155:abc')).toBeNull();
  });
});
