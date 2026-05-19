#!/usr/bin/env bash
# pay-morph-x402.sh — Pay an x402-protected URL on Morph Network via OWS.
# Returns structured JSON for AI-agent skill consumption.
set -euo pipefail

WALLET="" URL="" METHOD="GET" REFERENCE_KEY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --wallet) WALLET="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --method) METHOD="$2"; shift 2;;
    --reference-key) REFERENCE_KEY="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$WALLET" ] || [ -z "$URL" ]; then
  echo '{"ok":false,"error":"Usage: pay-morph-x402.sh --wallet <name> --url <endpoint> [--method GET|POST] [--reference-key ORD-001]","code":"INVALID_INPUT"}'
  exit 1
fi

if ! command -v ows &>/dev/null; then
  echo '{"ok":false,"error":"OWS CLI not found","code":"OWS_NOT_INSTALLED","hint":"Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash"}'
  exit 1
fi

if [ -z "${MORPH_ACCESS_KEY:-}" ] || [ -z "${MORPH_SECRET_KEY:-}" ]; then
  echo '{"ok":false,"error":"MORPH_ACCESS_KEY and MORPH_SECRET_KEY env vars required","code":"MORPH_NO_CREDENTIALS","hint":"Register at https://morph-rails.morph.network/x402"}'
  exit 1
fi

CMD="ows pay request --wallet $WALLET --url $URL --chain morph-mainnet"
[ "$METHOD" != "GET" ] && CMD="$CMD --method $METHOD"
[ -n "$REFERENCE_KEY" ] && CMD="$CMD --header x-payment-reference-key:$REFERENCE_KEY"

output=$(eval "$CMD" 2>&1) || {
  case "$output" in
    *insufficient*|*balance*) code="INSUFFICIENT_FUNDS"; hint="Fund Morph wallet with USDC: ows fund deposit --wallet $WALLET --chain morph-mainnet";;
    *401*|*unauthorized*|*signature*) code="MORPH_AUTH_FAILED"; hint="Verify MORPH_ACCESS_KEY/MORPH_SECRET_KEY and clock sync (±30s)";;
    *429*|*rate*) code="MORPH_RATE_LIMITED"; hint="Default 10 QPS per key — slow down or contact Morph for higher limits";;
    *policy*|*denied*) code="OWS_POLICY_DENIED"; hint="Adjust policy in your wallet config";;
    *) code="PAYMENT_FAILED"; hint="Check Morph USDC balance and facilitator status";;
  esac
  echo "{\"ok\":false,\"error\":\"Morph payment failed: $(echo "$output" | head -1 | tr '"' "'")\",\"code\":\"$code\",\"hint\":\"$hint\"}"
  exit 1
}

echo "{\"ok\":true,\"data\":{\"url\":\"$URL\",\"method\":\"$METHOD\",\"wallet\":\"$WALLET\",\"chain\":\"morph-mainnet\",\"reference_key\":\"$REFERENCE_KEY\",\"response\":$(echo "$output" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"$output\"")}}"
