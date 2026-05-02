#!/usr/bin/env bash
set -e

# ─── n-payment × GOAT Network — Full Demo ────────────────────────────────────
#
# Starts the demo server with embedded UI, then runs the GOAT client demo.
#
# Usage:
#   chmod +x demo/run.sh
#   ./demo/run.sh
#
# With real GOAT credentials:
#   GOAT_API_KEY=... GOAT_API_SECRET=... GOAT_MERCHANT_ID=... ./demo/run.sh
# ──────────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   n-payment × GOAT Network — Full Demo                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Check deps ──────────────────────────────────────────────────────────────

if ! command -v npx &>/dev/null; then
  echo "❌ npx not found. Install Node.js 18+."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "📦 Installing dependencies..."
  pnpm install
fi

# Check express is available
if [ ! -d node_modules/express ]; then
  echo "📦 Installing express for demo server..."
  pnpm add -D express @types/express
fi

# ─── Build SDK ───────────────────────────────────────────────────────────────

echo "🔨 Building n-payment SDK..."
pnpm build 2>&1 | tail -3
echo ""

# ─── Set defaults ────────────────────────────────────────────────────────────

export PAY_TO="${PAY_TO:-0x0000000000000000000000000000000000000001}"
export PORT="${PORT:-4000}"
export PRIVATE_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
export GOAT_API_KEY="${GOAT_API_KEY:-demo_key}"
export GOAT_API_SECRET="${GOAT_API_SECRET:-demo_secret}"
export GOAT_MERCHANT_ID="${GOAT_MERCHANT_ID:-demo_merchant}"

# ─── Start server ────────────────────────────────────────────────────────────

echo "🚀 Starting demo server on port $PORT..."
npx tsx demo/server.ts &
SERVER_PID=$!

# Wait for server to be ready
for i in $(seq 1 10); do
  if curl -s "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo ""
echo "✅ Server running (PID: $SERVER_PID)"
echo ""

# ─── Run GOAT client demo ───────────────────────────────────────────────────

echo "🐐 Running GOAT client demo..."
echo "────────────────────────────────────────────────────────────"
npx tsx examples/goat-demo.ts
echo "────────────────────────────────────────────────────────────"
echo ""

# ─── Test API endpoints ─────────────────────────────────────────────────────

echo "🧪 Testing API endpoints..."
echo ""

echo "  GET /health"
curl -s "http://localhost:$PORT/health" | npx -y json 2>/dev/null || curl -s "http://localhost:$PORT/health"
echo ""
echo ""

echo "  GET /api/weather (expect 402)"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/api/weather")
echo "  Status: $HTTP_CODE"
if [ "$HTTP_CODE" = "402" ]; then
  echo "  ✅ 402 Payment Required — dual challenge returned"
  echo "  Headers:"
  curl -sI "http://localhost:$PORT/api/weather" 2>/dev/null | grep -i "payment-required\|www-authenticate" | sed 's/^/    /'
else
  echo "  ⚠️  Expected 402, got $HTTP_CODE"
fi
echo ""

echo "  GET /api/goat-info"
curl -s "http://localhost:$PORT/api/goat-info" | head -c 200
echo "..."
echo ""

# ─── Open UI ─────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Demo Ready!                                          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║                                                        ║"
echo "║   🌐 UI:  http://localhost:$PORT                         ║"
echo "║   📋 API: http://localhost:$PORT/health                   ║"
echo "║                                                        ║"
echo "║   Press Ctrl+C to stop                                 ║"
echo "║                                                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Open browser on macOS
if command -v open &>/dev/null; then
  open "http://localhost:$PORT"
fi

# ─── Wait for Ctrl+C ────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "🛑 Stopping server (PID: $SERVER_PID)..."
  kill $SERVER_PID 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

wait $SERVER_PID
