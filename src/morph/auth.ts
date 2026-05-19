import { createHmac } from 'node:crypto';

/**
 * Morph x402 Facilitator HMAC-SHA256 authentication.
 *
 * Spec (https://docs.morph.network/docs/morph-rails/agentic-payment/x402-facilitator):
 *  1. Build sign map: MORPH-ACCESS-KEY, MORPH-ACCESS-TIMESTAMP, MORPH-ACCESS-METHOD,
 *     MORPH-ACCESS-PATH (full path incl. /x402 prefix, no query),
 *     plus flattened query params (values as string[]),
 *     plus MORPH-ACCESS-BODY = parsed JSON body (omit if no body).
 *  2. Recursively sort keys lexicographically at every depth.
 *  3. Serialize as compact JSON (no whitespace).
 *  4. signature = base64( HMAC-SHA256(secretKey, content) ).
 *
 * Note: JSON.stringify preserves insertion order in JS — recursive sort is required.
 */

/** Recursively sort all object keys in lexicographic order. Arrays preserve order. */
export function sortObjectDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectDeep);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortObjectDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export interface MorphSignParams {
  method: string;
  /** Full path including /x402 prefix (e.g. /x402/v2/settle). No query string. */
  path: string;
  /** Raw query string without leading `?`. Empty/undefined when no query. */
  query?: string;
  /** Raw JSON body string. Empty/undefined when no body. */
  body?: string;
  accessKey: string;
  secretKey: string;
  /** Override for tests. Default: Date.now() in ms. */
  timestamp?: string;
}

/** Returns the three required headers: MORPH-ACCESS-KEY, MORPH-ACCESS-TIMESTAMP, MORPH-ACCESS-SIGN. */
export function signMorphRequest(params: MorphSignParams): Record<string, string> {
  const { method, path, query, body, accessKey, secretKey } = params;
  const timestamp = params.timestamp ?? Date.now().toString();

  const signMap: Record<string, unknown> = {
    'MORPH-ACCESS-KEY': accessKey,
    'MORPH-ACCESS-TIMESTAMP': timestamp,
    'MORPH-ACCESS-METHOD': method.toUpperCase(),
    'MORPH-ACCESS-PATH': path,
  };

  if (query) {
    const usp = new URLSearchParams(query);
    for (const key of new Set(usp.keys())) signMap[key] = usp.getAll(key);
  }

  if (body) {
    try {
      signMap['MORPH-ACCESS-BODY'] = JSON.parse(body);
    } catch {
      // Non-JSON body — skip per spec (omit MORPH-ACCESS-BODY).
    }
  }

  const content = JSON.stringify(sortObjectDeep(signMap));
  const signature = createHmac('sha256', secretKey).update(content).digest('base64');

  return {
    'MORPH-ACCESS-KEY': accessKey,
    'MORPH-ACCESS-TIMESTAMP': timestamp,
    'MORPH-ACCESS-SIGN': signature,
  };
}
