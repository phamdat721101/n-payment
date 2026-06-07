#!/usr/bin/env bash
# skills/pay-rlusd-multichain.sh
#
# Pay any URL with RLUSD on any of 6 supported chains (XRPL + 5 EVM L2s).
# The SDK auto-routes via Wormhole NTT when the merchant chain differs from the
# buyer's RLUSD holdings.
#
# Usage:
#   skills/pay-rlusd-multichain.sh <url>
#   skills/pay-rlusd-multichain.sh check-balance --chain base-mainnet
#
# Env:
#   OWS_PRIVATE_KEY           — buyer signer
#   OPTIMISM_PRIVATE_KEY      — Wormhole signer for Optimism (optional)
#   BASE_PRIVATE_KEY          — Wormhole signer for Base (optional)
#   N_PAYMENT_CHAINS          — override the chain set (CSV)

set -euo pipefail

CHAINS="${N_PAYMENT_CHAINS:-xrpl-mainnet,base-mainnet,optimism-mainnet,ink-mainnet,unichain-mainnet,ethereum-mainnet}"
COMMAND="${1:?usage: pay-rlusd-multichain.sh <url|check-balance> [args]}"

case "${COMMAND}" in
  check-balance)
    shift
    exec npx -y n-payment balance \
      --chains "${CHAINS}" \
      --asset RLUSD \
      "$@"
    ;;
  *)
    URL="${COMMAND}"
    exec npx -y n-payment fetch \
      --chains "${CHAINS}" \
      --asset RLUSD \
      --url "${URL}"
    ;;
esac
