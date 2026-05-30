#!/usr/bin/env bash
# pay-flare-x402.sh — Pay an x402-protected URL on Flare via OWS.
# Returns structured JSON for AI-agent skill consumption.
# v0.19: --chain accepts flare-coston2-testnet (default), flare-songbird-mainnet, flare-mainnet.
set -euo pipefail

WALLET="" URL="" METHOD="GET" CHAIN="flare-coston2-testnet"
while [[ $# -gt 0 ]]; do
  case $1 in
    --wallet) WALLET="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --method) METHOD="$2"; shift 2;;
    --chain) CHAIN="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$WALLET" ] || [ -z "$URL" ]; then
  echo '{"ok":false,"error":"Usage: pay-flare-x402.sh --wallet <name> --url <endpoint> [--method GET|POST] [--chain flare-coston2-testnet|flare-songbird-mainnet|flare-mainnet]","code":"INVALID_INPUT"}'
  exit 1
fi

case "$CHAIN" in
  flare-coston2-testnet|flare-songbird-mainnet|flare-mainnet) ;;
  *)
    echo "{\"ok\":false,\"error\":\"Unknown chain $CHAIN\",\"code\":\"INVALID_CHAIN\",\"hint\":\"Use flare-coston2-testnet, flare-songbird-mainnet, or flare-mainnet\"}"
    exit 1;;
esac

if ! command -v ows &>/dev/null; then
  echo '{"ok":false,"error":"OWS CLI not found","code":"OWS_NOT_INSTALLED","hint":"Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash"}'
  exit 1
fi

# Flare x402 needs MockUSDT0 + X402Facilitator addresses (no public default — caller must deploy).
if [ -z "${FLARE_X402_TOKEN_ADDRESS:-}" ] || [ -z "${FLARE_X402_FACILITATOR_ADDRESS:-}" ]; then
  echo '{"ok":false,"error":"FLARE_X402_TOKEN_ADDRESS and FLARE_X402_FACILITATOR_ADDRESS env vars required","code":"FLARE_X402_NO_CONFIG","hint":"Deploy via: pnpm tsx examples/flare-payments-demo.ts deploy-x402 (see Flare docs for source contracts)"}'
  exit 1
fi

CMD="ows pay request --wallet $WALLET --url $URL --chain $CHAIN"
[ "$METHOD" != "GET" ] && CMD="$CMD --method $METHOD"

output=$(eval "$CMD" 2>&1) || {
  case "$output" in
    *insufficient*|*balance*) code="INSUFFICIENT_FUNDS"; hint="Fund $CHAIN wallet with MockUSDT0: testnet token has a public mint() — call MockUSDT0.mint(your_addr, amount).";;
    *FLARE_X402_VERIFY_FAILED*) code="FLARE_X402_VERIFY_FAILED"; hint="Common causes: validBefore expired, nonce already consumed, signature does not recover to from. Re-issue with fresh nonce/deadline.";;
    *FLARE_X402_SETTLE_FAILED*) code="FLARE_X402_SETTLE_FAILED"; hint="settlePayment reverted on-chain. Inspect tx on the Flare/Coston2 explorer (https://coston2-explorer.flare.network).";;
    *policy*|*denied*) code="OWS_POLICY_DENIED"; hint="Adjust policy in your wallet config";;
    *) code="PAYMENT_FAILED"; hint="Check $CHAIN MockUSDT0 balance, allowance, and facilitator status";;
  esac
  echo "{\"ok\":false,\"error\":\"$CHAIN payment failed: $(echo "$output" | head -1 | tr '"' "'")\",\"code\":\"$code\",\"hint\":\"$hint\"}"
  exit 1
}

echo "{\"ok\":true,\"data\":{\"url\":\"$URL\",\"method\":\"$METHOD\",\"wallet\":\"$WALLET\",\"chain\":\"$CHAIN\",\"response\":$(echo "$output" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))' 2>/dev/null || echo "\"$output\"")}}"
