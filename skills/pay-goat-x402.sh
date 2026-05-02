#!/usr/bin/env bash
set -euo pipefail

WALLET="" URL="" METHOD="GET"
while [[ $# -gt 0 ]]; do
  case $1 in
    --wallet) WALLET="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --method) METHOD="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$WALLET" ] || [ -z "$URL" ]; then
  echo '{"ok":false,"error":"Usage: pay-goat-x402.sh --wallet <name> --url <endpoint> [--method GET|POST]","code":"INVALID_INPUT"}'
  exit 1
fi

if ! command -v ows &>/dev/null; then
  echo '{"ok":false,"error":"OWS CLI not found","code":"OWS_NOT_INSTALLED","hint":"Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash"}'
  exit 1
fi

CMD="ows pay request --wallet $WALLET --url $URL"
[ "$METHOD" != "GET" ] && CMD="$CMD --method $METHOD"

output=$(eval "$CMD" 2>&1) || {
  case "$output" in
    *insufficient*|*balance*) code="INSUFFICIENT_FUNDS"; hint="Fund wallet: ows fund deposit --wallet $WALLET";;
    *policy*|*denied*) code="OWS_POLICY_DENIED"; hint="Adjust GOAT policy in config/policy-goat-agent.json";;
    *) code="PAYMENT_FAILED"; hint="Check USDC balance on GOAT Network";;
  esac
  echo "{\"ok\":false,\"error\":\"GOAT payment failed: $(echo "$output" | head -1 | tr '"' "'")\",\"code\":\"$code\",\"hint\":\"$hint\"}"
  exit 1
}

echo "{\"ok\":true,\"data\":{\"url\":\"$URL\",\"method\":\"$METHOD\",\"wallet\":\"$WALLET\",\"response\":$(echo "$output" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"$output\"")}}"
