#!/usr/bin/env bash
# pay-stellar-mgusd.sh — agent-skill wrapper for n-payment Stellar Session in MGUSD.
#
# Subcommands:
#   open-channel  : print the channel-open recipe (stub — caller deploys via Soroban CLI)
#   pay           : run the 1000-call benchmark example, emit the dashboard JSON line
#   close         : run the same example in close-only mode (echoes the JSON output)
#   --help        : print this help
#
# JSON output contract: stdout is exactly one JSON object per invocation
# (or `{"ok":false,"error":...}` on error).
#
# Env (required for live mode of `pay` / `close`):
#   STELLAR_MGUSD_CHANNEL=C…
#   STELLAR_COMMITMENT_SECRET=<32-byte hex>
#   STELLAR_COMMITMENT_PUBKEY=<32-byte hex>
#   STELLAR_CLOSE_SIGNER_SECRET=S…
# Optional:
#   STELLAR_MGUSD_ISSUER=G…  (override the placeholder Bridge issuer)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,18p' "${BASH_SOURCE[0]}"
  exit 0
}

emit_error() {
  printf '{"ok":false,"error":%s}\n' "$(printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
  exit 1
}

cmd="${1:-}"
case "$cmd" in
  --help|-h|"")
    usage
    ;;
  open-channel)
    cat <<EOF
{"ok":true,"command":"open-channel","note":"Deploy a one-way-channel Soroban contract for MGUSD via Stellar CLI: stellar contract deploy --network testnet --source <ACCOUNT> --wasm one-way-channel.wasm --constructor-args (asset=MGUSD,issuer=$STELLAR_MGUSD_ISSUER,recipient=<SERVER_G>,commitment_pubkey=<PUBKEY_HEX>). Set STELLAR_MGUSD_CHANNEL=<deployed_C_id> for subsequent pay/close calls."}
EOF
    ;;
  pay|close)
    cd "$REPO_ROOT"
    if ! command -v pnpm >/dev/null 2>&1; then
      emit_error "pnpm not found. Install pnpm and retry."
    fi
    pnpm tsx examples/stellar-mgusd-1000-calls.ts \
      || emit_error "1000-call example failed"
    ;;
  *)
    emit_error "unknown subcommand: $cmd. Run with --help."
    ;;
esac
