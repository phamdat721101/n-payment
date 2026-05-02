import { createHmac } from 'node:crypto';

/**
 * GOAT x402 HMAC-SHA256 auth per API.md spec:
 * 1. body fields + api_key + timestamp
 * 2. Remove empty values and 'sign' field
 * 3. Sort keys ASCII, build k1=v1&k2=v2
 * 4. HMAC-SHA256(apiSecret, sorted) → hex
 */
export function signGoatRequest(
  body: Record<string, unknown>,
  apiKey: string,
  apiSecret: string,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params: Record<string, string> = {};

  for (const [k, v] of Object.entries({ ...body, api_key: apiKey, timestamp })) {
    if (v !== '' && v !== null && v !== undefined && k !== 'sign') {
      params[k] = String(v);
    }
  }

  const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const sign = createHmac('sha256', apiSecret).update(message).digest('hex');

  return {
    'X-API-Key': apiKey,
    'X-Timestamp': timestamp,
    'X-Sign': sign,
    'Content-Type': 'application/json',
  };
}
