#!/usr/bin/env bash
# pay-celo-x402.sh — Pay an x402-protected URL on Celo via CIP-64 fee abstraction.
# v0.25: --chain accepts celo-mainnet (default), celo-sepolia.
# The agent never holds CELO — gas is paid in USDC/USDT/USDm via fee-currency adapter.
# Returns structured JSON for AI-agent skill consumption.
set -euo pipefail

WALLET="" URL="" METHOD="GET" CHAIN="celo-mainnet" PAY_ASSET="USDC"
while [[ $# -gt 0 ]]; do
  case $1 in
    --wallet) WALLET="$2"; shift 2;;
    --url) URL="$2"; shift 2;;
    --method) METHOD="$2"; shift 2;;
    --chain) CHAIN="$2"; shift 2;;
    --pay-asset) PAY_ASSET="$2"; shift 2;;
    *) shift;;
  esac
done

if [ -z "$WALLET" ] || [ -z "$URL" ]; then
  echo '{"ok":false,"error":"Usage: pay-celo-x402.sh --wallet <name> --url <endpoint> [--method GET|POST] [--chain celo-mainnet|celo-sepolia] [--pay-asset USDC|USDT|USDm]","code":"INVALID_INPUT"}'
  exit 1
fi

case "$CHAIN" in
  celo-mainnet|celo-sepolia) ;;
  *)
    echo "{\"ok\":false,\"error\":\"Unknown chain $CHAIN\",\"code\":\"INVALID_CHAIN\",\"hint\":\"Use celo-mainnet (42220) or celo-sepolia (11142220)\"}"
    exit 1;;
esac

case "$PAY_ASSET" in
  USDC|USDT|USDm) ;;
  *)
    echo "{\"ok\":false,\"error\":\"Unknown payAsset $PAY_ASSET\",\"code\":\"INVALID_PAY_ASSET\",\"hint\":\"Use USDC, USDT, or USDm\"}"
    exit 1;;
esac

# USDT fee abstraction is mainnet-only in v0.25.
if [ "$CHAIN" = "celo-sepolia" ] && [ "$PAY_ASSET" = "USDT" ]; then
  echo '{"ok":false,"error":"USDT fee abstraction not available on celo-sepolia","code":"INVALID_PAY_ASSET","hint":"Use USDC on sepolia, or switch to celo-mainnet for USDT."}'
  exit 1
fi

if ! command -v ows &>/dev/null; then
  echo '{"ok":false,"error":"OWS CLI not found","code":"OWS_NOT_INSTALLED","hint":"Install: curl -fsSL https://docs.openwallet.sh/install.sh | bash"}'
  exit 1
fi

CMD="ows pay request --wallet $WALLET --url $URL --chain $CHAIN --pay-asset $PAY_ASSET"
[ "$METHOD" != "GET" ] && CMD="$CMD --method $METHOD"

output=$(eval "$CMD" 2>&1) || {
  code="PAYMENT_FAILED"
  hint="Check Celo $PAY_ASSET balance, EIP-3009 signing capability, and merchant facilitator availability."
  case "$output" in
    *insufficient*|*balance*)
      code="INSUFFICIENT_FUNDS"
      if [ "$CHAIN" = "celo-sepolia" ]; then
        hint="Fund celo-sepolia $PAY_ASSET via the Celo Sepolia faucet at https://faucet.celo.org."
      else
        hint="Fund celo-mainnet $PAY_ASSET via Squid, Mento, or any Celo on-ramp."
      fi
      ;;
    *CELO_FEE_ABSTRACTION_REJECTED*)
      code="CELO_FEE_ABSTRACTION_REJECTED"
      hint="Fee-currency adapter not registered for $PAY_ASSET on $CHAIN. Pass celo.feeCurrencyAdapterOverride or upgrade chains.ts."
      ;;
    *NO_SIGNER*)
      code="NO_SIGNER"
      hint="The wallet has no signing privateKey wired. Check OWS config or pass ows.privateKey."
      ;;
    *policy*|*denied*) code="OWS_POLICY_DENIED"; hint="Adjust policy in your wallet config.";;
  esac
  echo "{\"ok\":false,\"error\":$(printf '%s' "$output" | head -c 200 | jq -R . 2>/dev/null || echo '"failed"'),\"code\":\"$code\",\"hint\":\"$hint\"}"
  exit 1
}

echo "$output"
