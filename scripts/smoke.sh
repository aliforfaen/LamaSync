#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export LAMASYNC_API_KEY="smoke-key"
export LAMASYNC_DATA_DIR="/tmp/lamasync-smoke-data"
export LAMASYNC_BACKUP_DIR="/tmp/lamasync-smoke-backups"

# Pick a random free port so stale dev servers on 8080 don't collide.
PORT="${PORT:-}"
if [ -z "$PORT" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
  else
    PORT=8080
  fi
fi
export PORT

rm -rf "$LAMASYNC_DATA_DIR" "$LAMASYNC_BACKUP_DIR"
mkdir -p "$LAMASYNC_DATA_DIR" "$LAMASYNC_BACKUP_DIR"

bun run packages/server/src/index.ts > "/tmp/lamasync-smoke-server-${PORT}.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -rf "$LAMASYNC_DATA_DIR" "$LAMASYNC_BACKUP_DIR" "/tmp/smoke.tar.gz"' EXIT

sleep 2

echo "--- health (port $PORT) ---"
curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health" | head -c 200

echo ""
echo "--- report retry ---"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"hostId":"smoke-host","folderId":"f1","operation":"sync","status":"retry","summary":"smoke"}' \
  "http://127.0.0.1:${PORT}/api/v1/report"

echo "--- create manifest ---"
curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"appName":"opencode","paths":["~/.config/opencode"],"instructions":"Restart."}' \
  "http://127.0.0.1:${PORT}/api/v1/dotfiles/manifests"

echo ""
echo "--- register host ---"
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"id":"smoke-host","hostname":"smoke-host"}' \
  "http://127.0.0.1:${PORT}/api/v1/register"

echo "--- config manifests ---"
curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/config/smoke-host" | jq '.manifests'

echo "--- upload tarball ---"
printf 'fake tarball content' > /tmp/smoke.tar.gz
curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" -F "tarball=@/tmp/smoke.tar.gz" \
  "http://127.0.0.1:${PORT}/api/v1/dotfiles/opencode" | jq '{sizeBytes,checksum,description}'

echo "--- list versions ---"
curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/dotfiles/opencode" | jq 'length'
