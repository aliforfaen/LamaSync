#!/usr/bin/env bash
set -euo pipefail

# LamaSync Exoscale S3 end-to-end test
# ------------------------------------
# Requires Exoscale SOS credentials in the environment:
#   EXO_ENDPOINT         e.g. sos-at-vie-1.exo.io
#   EXO_BUCKET           existing bucket name
#   EXO_ACCESS_KEY       Exoscale IAM access key
#   EXO_SECRET_KEY       Exoscale IAM secret key
#
# The test creates an S3-backed folder, fetches the generated rclone config,
# verifies the bucket is reachable with rclone ls, and cleans up.
#
# Usage:
#   EXO_ENDPOINT=sos-at-vie-1.exo.io EXO_BUCKET=lamasync-test \
#     EXO_ACCESS_KEY=... EXO_SECRET_KEY=... ./scripts/e2e-exoscale.sh

if [ -z "${EXO_ENDPOINT:-}" ] || [ -z "${EXO_BUCKET:-}" ] || [ -z "${EXO_ACCESS_KEY:-}" ] || [ -z "${EXO_SECRET_KEY:-}" ]; then
  echo "SKIP: EXO_ENDPOINT, EXO_BUCKET, EXO_ACCESS_KEY, and EXO_SECRET_KEY must be set"
  exit 0
fi

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

export LAMASYNC_API_KEY="e2e-exoscale-key"
export LAMASYNC_DATA_DIR="$ROOT/tmp/e2e-exoscale/data"
export LAMASYNC_BACKUP_DIR="$ROOT/tmp/e2e-exoscale/backups"
export LAMASYNC_LOG_RETENTION_DAYS=30

E2E_DIR="$ROOT/tmp/e2e-exoscale"
rm -rf "$E2E_DIR"
mkdir -p "$LAMASYNC_DATA_DIR" "$LAMASYNC_BACKUP_DIR" "$E2E_DIR"

if command -v python3 >/dev/null 2>&1; then
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("",0)); print(s.getsockname()[1]); s.close()')
else
  PORT=8080
fi
export PORT

SERVER_PID=""

cleanup() {
  trap - INT TERM EXIT
  echo "[cleanup] stopping server..."
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  wait 2>/dev/null || true
  rm -rf "$E2E_DIR"
}
trap cleanup INT TERM EXIT

echo "=== LamaSync Exoscale S3 e2e test ==="
echo "Endpoint: $EXO_ENDPOINT"
echo "Bucket:   $EXO_BUCKET"
echo "Port:     $PORT"
echo ""

if [ ! -f "packages/server/dist/lamasync-server" ]; then
  echo "[build] compiling server binary..."
  bun run build:server > "$E2E_DIR/build.log" 2>&1
fi

echo "[server] starting lamasync-server on port $PORT..."
./packages/server/dist/lamasync-server > "$E2E_DIR/server.log" 2>&1 &
SERVER_PID=$!

for i in $(seq 1 30); do
  if curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

HEALTH=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/health")
echo "[server] health: $HEALTH"

echo "[setup] registering host..."
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"id":"exoscale-host","hostname":"exoscale-host"}' \
  "http://127.0.0.1:${PORT}/api/v1/register"

echo "[setup] creating Exoscale S3 folder..."
FOLDER_JSON=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d "{\"name\":\"ExoTest\",\"type\":\"backup\",\"backend\":\"s3\",\"s3Provider\":\"exoscale\",\"s3Endpoint\":\"${EXO_ENDPOINT}\",\"s3Bucket\":\"${EXO_BUCKET}\",\"s3AccessKeyId\":\"${EXO_ACCESS_KEY}\",\"s3SecretAccessKey\":\"${EXO_SECRET_KEY}\"}" \
  "http://127.0.0.1:${PORT}/api/v1/folders")
FOLDER_ID=$(echo "$FOLDER_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin)["id"])')
echo "[setup] folder id: $FOLDER_ID"

echo "[setup] assigning folder to host..."
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $LAMASYNC_API_KEY" -H "Content-Type: application/json" \
  -d '{"hostId":"exoscale-host","role":"source","localPath":"/tmp/lamasync-exoscale-local","syncExpr":"0 0 1 1 *","enabled":true}' \
  "http://127.0.0.1:${PORT}/api/v1/folders/${FOLDER_ID}/assign"

echo "[config] fetching rclone config..."
CONFIG_JSON=$(curl -s -H "Authorization: Bearer $LAMASYNC_API_KEY" "http://127.0.0.1:${PORT}/api/v1/config/exoscale-host")
echo "$CONFIG_JSON" | python3 -c 'import sys, json; c=json.load(sys.stdin)["rcloneConfig"]; print(c)'
RCONFIG="$E2E_DIR/rclone.conf"
echo "$CONFIG_JSON" | python3 -c 'import sys, json; print(json.load(sys.stdin)["rcloneConfig"])' > "$RCONFIG"
chmod 600 "$RCONFIG"

echo "[rclone] verifying bucket access with 'rclone ls'..."
rclone --config "$RCONFIG" ls "lamasync-${FOLDER_ID}:" --max-depth 1

echo "[rclone] uploading a test object..."
TEST_FILE="$E2E_DIR/hello-exoscale.txt"
echo "hello from lamasync e2e" > "$TEST_FILE"
rclone --config "$RCONFIG" copy "$TEST_FILE" "lamasync-${FOLDER_ID}:"

echo "[rclone] listing bucket contents..."
OBJECTS=$(rclone --config "$RCONFIG" ls "lamasync-${FOLDER_ID}:" --max-depth 1)
echo "$OBJECTS"

if echo "$OBJECTS" | grep -q "hello-exoscale.txt"; then
  echo "[ok] object found in bucket"
else
  echo "[fail] object not found in bucket"
  exit 1
fi

echo ""
echo "=== Exoscale S3 e2e test passed ==="
