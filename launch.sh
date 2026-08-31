#!/usr/bin/env bash
# Shared Excalidraw server launcher
# First invocation starts the server. Subsequent invocations create a new canvas on the existing server.
#
# Usage:
#   bash launch.sh          # start/connect to shared server, create new canvas
#   mcp-call excalidraw-<canvasId> create_element --type=rectangle ...
#
# Architecture:
#   launch.sh → shared canvas server (stateful, stays running)
#   mcp-call  → MCP server (stateless proxy, spawned per call) → canvas server
#
# Cleanup is automatic: canvas + mcp-call registration removed on exit/kill.
#
# Notes:
#   Server log: ~/Library/Logs/excalidraw-mcp.log (LOG_FILE_PATH overrides).
#   Upstream also writes ~/Library/Application Support/excalidraw-canvas/server-<port>.pid,
#   removed by the same process on SIGTERM.
#   EXCALIDRAW_NO_BROWSER_OPEN=1 disables headless auto-open.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT_FILE="${SCRIPT_DIR}/.excalidraw-server-port"
SERVER_PID_FILE="${SCRIPT_DIR}/.excalidraw-server-pid"

# Check if server is already running
server_running() {
  if [ -f "$PORT_FILE" ] && [ -f "$SERVER_PID_FILE" ]; then
    local port=$(cat "$PORT_FILE")
    local pid=$(cat "$SERVER_PID_FILE")
    if kill -0 "$pid" 2>/dev/null && curl -sf "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      # Never "reuse" a foreign listener that happens to occupy the recorded port
      if curl -sf "http://127.0.0.1:${port}/health" | grep -q '"service":"mcp-excalidraw-canvas"'; then
        return 0
      fi
    fi
  fi
  return 1
}

STARTED_SERVER=""

if server_running; then
  PORT=$(cat "$PORT_FILE")
  echo "Reusing existing server on port ${PORT}"
else
  # Grab a free port by binding to port 0 and reading the OS-assigned port
  PORT=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  export PORT

  # Start the canvas server (Express + WebSocket) in the background
  node "${SCRIPT_DIR}/dist/server.js" &
  SERVER_PID=$!
  STARTED_SERVER="$SERVER_PID"

  echo "$PORT" > "$PORT_FILE"
  echo "$SERVER_PID" > "$SERVER_PID_FILE"

  # Poll /health until canvas is ready (max 2.5s)
  for i in 1 2 3 4 5; do
    curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# Generate a unique canvas ID for this session
CANVAS_ID="canvas-$(date +%s)-$(head -c 4 /dev/urandom | xxd -p)"

# Create the canvas on the server
curl -sf -X POST "http://127.0.0.1:${PORT}/api/canvases" \
  -H "Content-Type: application/json" \
  -d "{\"id\": \"${CANVAS_ID}\"}" >/dev/null

# Register this session's MCP server with mcp-call (stateless proxy to canvas)
mcp-call --add "excalidraw-${CANVAS_ID}" node "${SCRIPT_DIR}/dist/index.js" \
  --env "EXPRESS_SERVER_URL=http://127.0.0.1:${PORT}" \
  --env "ENABLE_CANVAS_SYNC=true" \
  --env "EXCALIDRAW_NO_AUTOSTART=1" \
  --env "CANVAS_ID=${CANVAS_ID}"

echo "Canvas:   http://127.0.0.1:${PORT}/?canvasId=${CANVAS_ID}"
echo "Canvases: http://127.0.0.1:${PORT}/canvases"
echo "MCP:      mcp-call excalidraw-${CANVAS_ID} <tool> ..."
echo "CLI:      node ${SCRIPT_DIR}/dist/bin.js --url http://127.0.0.1:${PORT} --canvas ${CANVAS_ID} <command>"

if [ -n "$STARTED_SERVER" ]; then
  # We started the server — clean up everything on exit
  cleanup() {
    curl -sf -X DELETE "http://127.0.0.1:${PORT}/api/canvases/${CANVAS_ID}" >/dev/null 2>&1 || true
    mcp-call --remove "excalidraw-${CANVAS_ID}" 2>/dev/null || true
    kill "$STARTED_SERVER" 2>/dev/null || true
    rm -f "$PORT_FILE" "$SERVER_PID_FILE"
  }
  trap cleanup EXIT INT TERM
  # Keep script alive as long as canvas server is running
  wait "$STARTED_SERVER"
else
  # We reused existing server — only clean up our canvas
  cleanup() {
    curl -sf -X DELETE "http://127.0.0.1:${PORT}/api/canvases/${CANVAS_ID}" >/dev/null 2>&1 || true
    mcp-call --remove "excalidraw-${CANVAS_ID}" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM
  echo "Press Ctrl+C to disconnect this canvas session"
  # Keep alive until killed. tail runs in the background and we `wait` on it:
  # bash's wait builtin is signal-interruptible, while a foreground child would
  # defer the trap until it exits (cleanup would never run on `kill`).
  tail -f /dev/null &
  KEEPALIVE_PID=$!
  trap 'kill "$KEEPALIVE_PID" 2>/dev/null; cleanup' EXIT INT TERM
  wait "$KEEPALIVE_PID"
fi
