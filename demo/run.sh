#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."

MODE=${1:-testnet}

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║   n-payment v0.4 — Demo Runner                      ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  pnpm install
fi

echo "🔨 Building SDK..."
pnpm build 2>&1 | tail -2
echo ""

case $MODE in
  testnet)
    echo "🧪 Running testnet CLI demo..."
    npx tsx demo/cli-demo.ts
    ;;
  services)
    echo "🚀 Starting mock x402 services on port ${SERVICES_PORT:-4021}..."
    npx tsx demo/services.ts
    ;;
  dashboard)
    echo "🚀 Starting mock services + dashboard..."
    SERVICES_PORT=${SERVICES_PORT:-4021} npx tsx demo/services.ts &
    SVC_PID=$!
    sleep 1
    npx tsx demo/dashboard.ts &
    DASH_PID=$!
    echo ""
    echo "✅ Services: http://localhost:${SERVICES_PORT:-4021}/health"
    echo "✅ Dashboard: http://localhost:${DASHBOARD_PORT:-4022}"
    echo ""
    echo "Press Ctrl+C to stop"
    if command -v open &>/dev/null; then open "http://localhost:${DASHBOARD_PORT:-4022}"; fi
    cleanup() { kill $SVC_PID $DASH_PID 2>/dev/null || true; }
    trap cleanup EXIT INT TERM
    wait
    ;;
  *)
    echo "Usage: ./demo/run.sh [testnet|services|dashboard]"
    echo ""
    echo "  testnet    — Run CLI demo (default)"
    echo "  services   — Start mock x402 service server"
    echo "  dashboard  — Start services + web dashboard"
    ;;
esac
