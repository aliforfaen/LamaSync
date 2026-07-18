#!/usr/bin/env bash
set -euo pipefail

# LamaSync end-to-end test harness
# --------------------------------
# Starts a fully isolated server + daemon on a random free port, registers a
# host, creates a folder assignment, and prints access/usage instructions.
#
# Usage:
#   ./scripts/e2e-harness.sh        # use existing binaries if present
#   ./scripts/e2e-harness.sh --rebuild
#
# The harness runs in the foreground. Press Ctrl+C to stop the server and
# daemon and return to the shell. Logs and temp data are left in
# ./tmp/e2e/ for inspection.

REBUILD=0
if [ "${1:-}" = "--rebuild" ]; then
  REBUILD=1
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export LAMASYNC_API_KEY="e2e-test-key"
export LAMASYNC_DATA_DIR="$ROOT/tmp/e2e/data"
export LAMASYNC_BACKUP_DIR="$ROOT/tmp/e2e/backups"
export LAMASYNC_LOG_RETENTION_DAYS=30

TMP_HOME="$ROOT/tmp/e2e/home"
SOCKET_PATH="$TMP_HOME/lamasync.sock"
E2E_LOG_DIR="$ROOT/tmp/e2e"
E2E_LOG="$E2E_LOG_DIR/e2e.log"

if command -v python3 >/dev/null 2>&1; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
else
  PORT=8080
fi
export PORT

SERVER_PID=""
DAEMON_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo ""
  echo "[cleanup] Stopping background processes..."
  if [ -n "$DAEMON_PID" ]; then kill "$DAEMON_PID" 2>/dev/null || true; fi
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  echo "[cleanup] Done. Logs and temp data left in $E2E_LOG_DIR/"
}
trap cleanup INT TERM EXIT

echo "=== LamaSync end-to-end test harness ==="
echo "API key:  $LAMASYNC_API_KEY"
echo "Port:     $PORT"
echo "Temp dir: $E2E_LOG_DIR"
echo ""

rm -rf "$E2E_LOG_DIR"
mkdir -p "$LAMASYNC_DATA_DIR" "$LAMASYNC_BACKUP_DIR" "$TMP_HOME/.config/lamasync" "$TMP_HOME/E2E-Files"

if [ "$REBUILD" -eq 1 ] || [ ! -f "packages/server/dist/lamasync-server" ] || [ ! -f "packages/daemon/dist/lamasyncd" ] || [ ! -f "packages/tui/dist/lamasync-tui" ]; then
  echo "[build] Building binaries..."
  bun run build > "$E2E_LOG" 2>&1
  echo "[build] OK"
else
  echo "[build] Binaries already present; skipping build (pass --rebuild to force)"
fi

cat > "$TMP_HOME/.config/lamasync/client.toml" <<EOF
serverUrl = "http://127.0.0.1:${PORT}"
apiKey = "${LAMASYNC_API_KEY}"
hostname = "e2e-host"
dataDir = "${LAMASYNC_DATA_DIR}"
EOF
chmod 600 "$TMP_HOME/.config/lamasync/client.toml"

echo "[server] Starting lamasync-server on port $PORT..."
./packages/server/dist/lamasync-server > "$E2E_LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

HEALTH=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health")
echo "[server] Health: $HEALTH"

echo "[setup] Registering host and creating test folder..."
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"id":"e2e-host","hostname":"e2e-host"}' \
  "http://127.0.0.1:${PORT}/api/v1/register"

FOLDER_JSON=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"E2E-Files","type":"sync"}' \
  "http://127.0.0.1:${PORT}/api/v1/folders")
FOLDER_ID=$(echo "$FOLDER_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
echo "[setup] Created folder $FOLDER_ID"

curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d "{\"hostId\":\"e2e-host\",\"role\":\"both\",\"localPath\":\"${TMP_HOME}/E2E-Files\",\"syncExpr\":\"0 0 1 1 *\",\"enabled\":true,\"conflictStrategy\":\"newer_wins\"}" \
  "http://127.0.0.1:${PORT}/api/v1/folders/${FOLDER_ID}/assign"

echo "[daemon] Starting lamasyncd..."
HOME="$TMP_HOME" LAMASYNC_SOCKET_PATH="$SOCKET_PATH" ./packages/daemon/dist/lamasyncd > "$E2E_LOG_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!

for i in $(seq 1 30); do
  ONLINE=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health" | python3 -c 'import sys, json; print(json.load(sys.stdin)["onlineCount"])')
  if [ "$ONLINE" -ge 1 ]; then
    break
  fi
  sleep 0.2
done

ONLINE=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health" | python3 -c 'import sys, json; print(json.load(sys.stdin)["onlineCount"])')
echo "[daemon] Online hosts: $ONLINE"

echo "[tui] Running TUI CLI fallback..."
HOME="$TMP_HOME" LAMASYNC_NO_TUI=1 LAMASYNC_SERVER_URL="http://127.0.0.1:${PORT}" LAMASYNC_API_KEY="$LAMASYNC_API_KEY" ./packages/tui/dist/lamasync-tui

echo ""
echo "=== Harness is running ==="
echo "Server:   http://127.0.0.1:${PORT}/"
echo "Web UI:   http://127.0.0.1:${PORT}/"
echo "Swagger:  http://127.0.0.1:${PORT}/swagger"
echo "API key:  $LAMASYNC_API_KEY"
echo "Socket:   $SOCKET_PATH"
echo "Logs:     $E2E_LOG_DIR/"
echo ""
echo "Usage examples:"
echo "  # Interactive TUI (local mode via Unix socket)"
echo "  HOME=$TMP_HOME LAMASYNC_SOCKET_PATH=$SOCKET_PATH ./packages/tui/dist/lamasync-tui"
echo ""
echo "  # CLI fallback (fleet summary, no native renderer needed)"
echo "  HOME=$TMP_HOME LAMASYNC_NO_TUI=1 LAMASYNC_SERVER_URL=http://127.0.0.1:${PORT} LAMASYNC_API_KEY=$LAMASYNC_API_KEY ./packages/tui/dist/lamasync-tui"
echo ""
echo "  # API sanity check"
echo "  curl -H 'Authorization: Bearer $LAMASYNC_API_KEY' http://127.0.0.1:${PORT}/api/v1/health"
echo ""
echo "Press Ctrl+C to stop the harness."

wait
