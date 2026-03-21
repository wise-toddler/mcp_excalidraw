#!/usr/bin/env bash
# Per-session Excalidraw launcher
# Starts an isolated canvas server on a random free port and registers it with mcp-call.
# Each invocation = independent canvas (own port, own in-memory state).
#
# Usage:
#   bash launch.sh          # start a new isolated session
#   mcp-call excalidraw-<port> create_element --type=rectangle ...
#
# Architecture:
#   launch.sh → canvas server (stateful, stays running)
#   mcp-call  → MCP server (stateless proxy, spawned per call) → canvas server
#
# Cleanup is automatic: canvas + mcp-call registration removed on exit/kill.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Grab a free port by binding to port 0 and reading the OS-assigned port
PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
export PORT

# Start the canvas server (Express + WebSocket) in the background
node "${SCRIPT_DIR}/dist/server.js" &
CANVAS_PID=$!

# On exit: kill canvas server and deregister from mcp-call
cleanup() {
  kill "$CANVAS_PID" 2>/dev/null || true
  mcp-call --remove "excalidraw-${PORT}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Poll /health until canvas is ready (max 2.5s)
for i in 1 2 3 4 5; do
  curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

# Register this session's MCP server with mcp-call (stateless proxy to canvas)
mcp-call --add "excalidraw-${PORT}" node "${SCRIPT_DIR}/dist/index.js" \
  --env "EXPRESS_SERVER_URL=http://localhost:${PORT}" \
  --env "ENABLE_CANVAS_SYNC=true"

echo "Canvas: http://localhost:${PORT}"
echo "MCP:    mcp-call excalidraw-${PORT} <tool> ..."

# Keep script alive as long as canvas server is running
wait "$CANVAS_PID"
