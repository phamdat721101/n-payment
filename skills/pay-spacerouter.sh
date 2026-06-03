#!/usr/bin/env bash
# pay-spacerouter.sh — The canonical "two prompts, zero crypto setup" entry point
# for n-payment + Creditcoin + SpaceRouter. Mirrors the pay-flare-x402.sh /
# pay-morph-x402.sh / pay-goat-x402.sh structured-JSON contract so any AI agent
# can shell out and consume the result.
#
# Subcommands:
#   check-balance --chain <creditcoin-mainnet|creditcoin-testnet>
#   pay --url <url> [--region US|KR|JP|GB] [--ip-type residential|mobile|business|hosting]
#       [--chain <creditcoin-mainnet|creditcoin-testnet>]
#   --help
#
# Env (forwarded to examples/spacerouter-quickstart.ts):
#   CREDITCOIN_PRIVATE_KEY (required), SR_ESCROW_ADDRESS, SR_TOKEN_ADDRESS,
#   SR_GATEWAY_URL, SR_API_KEY.
#
# Run from the n-payment repo root:
#   bash skills/pay-spacerouter.sh check-balance --chain creditcoin-testnet
set -euo pipefail

CMD="${1:-}"
shift || true

CHAIN="creditcoin-testnet"
URL=""
REGION=""
IPTYPE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --chain)   CHAIN="$2"; shift 2;;
    --url)     URL="$2"; shift 2;;
    --region)  REGION="$2"; shift 2;;
    --ip-type) IPTYPE="$2"; shift 2;;
    --help|-h) CMD="--help"; shift;;
    *)         shift;;
  esac
done

emit_err() {
  printf '{"ok":false,"error":%s,"code":"%s","hint":%s}\n' \
    "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$1\"")" \
    "$2" \
    "$(printf '%s' "$3" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$3\"")"
}

if [[ "$CMD" == "--help" || -z "$CMD" ]]; then
  cat <<'USAGE'
Usage: pay-spacerouter.sh <check-balance|pay> [flags]

  check-balance --chain <creditcoin-mainnet|creditcoin-testnet>
      Read $SPACE escrow balance for the configured wallet.

  pay --url <url>
      [--region US|KR|JP|GB]
      [--ip-type residential|mobile|business|hosting]
      [--chain <creditcoin-mainnet|creditcoin-testnet>]
      Route an HTTP request through SpaceRouter, paying $SPACE per byte.

Env: CREDITCOIN_PRIVATE_KEY (required), SR_ESCROW_ADDRESS, SR_TOKEN_ADDRESS,
     SR_GATEWAY_URL, SR_API_KEY.

Two-prompt agent UX:
  1. "check my balance on creditcoin-testnet"
       → bash skills/pay-spacerouter.sh check-balance --chain creditcoin-testnet
  2. "pay for httpbin.org/ip via SpaceRouter, region KR, residential"
       → bash skills/pay-spacerouter.sh pay --url https://httpbin.org/ip --region KR --ip-type residential
USAGE
  exit 0
fi

case "$CHAIN" in
  creditcoin-mainnet) export SR_NETWORK=mainnet;;
  creditcoin-testnet) export SR_NETWORK=testnet;;
  *) emit_err "Unknown chain $CHAIN" "INVALID_CHAIN" "Use creditcoin-mainnet or creditcoin-testnet."; exit 1;;
esac

if [[ -z "${CREDITCOIN_PRIVATE_KEY:-}" ]]; then
  emit_err "CREDITCOIN_PRIVATE_KEY env var is required" "MISSING_PRIVATE_KEY" "Set it (do NOT echo it): export CREDITCOIN_PRIVATE_KEY=0x..."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  emit_err "npx not found in PATH" "NPX_NOT_INSTALLED" "Install Node.js >= 18 (which ships npx)."
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUICKSTART="$REPO_ROOT/examples/spacerouter-quickstart.ts"
if [[ ! -f "$QUICKSTART" ]]; then
  emit_err "examples/spacerouter-quickstart.ts not found" "EXAMPLE_MISSING" "Run this skill from the n-payment repo root."
  exit 1
fi

case "$CMD" in
  check-balance)
    npx --yes tsx "$QUICKSTART" check
    ;;
  pay)
    if [[ -z "$URL" ]]; then
      emit_err "--url is required for pay" "INVALID_INPUT" "Pass --url https://your-target.example/path"
      exit 1
    fi
    args=("pay" "--url" "$URL")
    [[ -n "$REGION" ]] && args+=("--region" "$REGION")
    [[ -n "$IPTYPE" ]] && args+=("--ip-type" "$IPTYPE")
    npx --yes tsx "$QUICKSTART" "${args[@]}"
    ;;
  *)
    emit_err "Unknown subcommand: $CMD" "INVALID_SUBCOMMAND" "Try: check-balance | pay | --help"
    exit 1
    ;;
esac
