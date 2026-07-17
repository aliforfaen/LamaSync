#!/usr/bin/env bash
set -euo pipefail

: "${LAMASYNC_SERVER_URL:?must be set}"
: "${LAMASYNC_API_KEY:?must be set}"
: "${LAMASYNC_MINIO_ROOT_USER:?must be set}"
: "${LAMASYNC_MINIO_ROOT_PASSWORD:?must be set}"
: "${LAMASYNC_MINIO_BUCKET:?must be set}"
: "${LAMASYNC_HOSTNAME:=lamasync-daemon-test}"

API_BASE="${LAMASYNC_SERVER_URL}/api/v1"
MINIO_ENDPOINT="http://minio:9000"
SOCKET_PATH="/run/lamasync.sock"
REPORT_DIR="/tmp/lamasync-dogfood-report"
mkdir -p "$REPORT_DIR"

log() { echo "[dogfood] $*"; }
fail() { echo "[dogfood] FAIL: $*" >&2; exit 1; }

call_api() {
  local method="$1" path="$2" body="${3:-}"
  local opts=(-fsS -H "Authorization: Bearer ${LAMASYNC_API_KEY}" -H "Content-Type: application/json")
  if [ -n "$body" ]; then opts+=(-d "$body"); fi
  curl "${opts[@]}" "${API_BASE}${path}"
}

wait_for_server() {
  log "waiting for server at ${LAMASYNC_SERVER_URL}..."
  for i in {1..60}; do
    if curl -fsS -H "Authorization: Bearer ${LAMASYNC_API_KEY}" "${API_BASE}/health" >/dev/null 2>&1; then
      log "server is healthy"
      return
    fi
    sleep 1
  done
  fail "server did not become healthy"
}

wait_for_daemon_socket() {
  log "waiting for daemon socket at ${SOCKET_PATH}..."
  for i in {1..60}; do
    if [ -S "$SOCKET_PATH" ]; then
      log "daemon socket is ready"
      return
    fi
    sleep 1
  done
  fail "daemon socket did not appear"
}

setup_minio() {
  log "configuring minio client..."
  mc alias set testminio "$MINIO_ENDPOINT" "$LAMASYNC_MINIO_ROOT_USER" "$LAMASYNC_MINIO_ROOT_PASSWORD" >/dev/null
  if ! mc ls testminio/"$LAMASYNC_MINIO_BUCKET" >/dev/null 2>&1; then
    log "creating bucket ${LAMASYNC_MINIO_BUCKET}..."
    mc mb testminio/"$LAMASYNC_MINIO_BUCKET" >/dev/null
  else
    log "bucket ${LAMASYNC_MINIO_BUCKET} already exists"
  fi
}

snapshot() {
  local name="$1"
  log "snapshot: $name"
  {
    echo "=== $name ==="
    echo "--- server health ---"
    call_api GET /health || true
    echo
    echo "--- folders ---"
    call_api GET /folders || true
    echo
    echo "--- operations ---"
    call_api GET /operations?limit=20 || true
  } > "$REPORT_DIR/${name}.txt" 2>&1
}

run_tui() {
  local name="$1"
  log "running TUI CLI fallback: $name"
  LAMASYNC_NO_TUI=1 lamasync-tui > "$REPORT_DIR/${name}.txt" 2>&1 || true
}

socket_cmd() {
  printf '%s\n' "$1" | socat - UNIX-CONNECT:"$SOCKET_PATH" || true
}

main() {
  wait_for_server
  wait_for_daemon_socket
  setup_minio

  run_tui "tui-before-setup"
  snapshot "api-before-setup"

  log "creating S3 folder..."
  FOLDER_RESPONSE=$(call_api POST /folders "$(jq -n \
    --arg bucket "$LAMASYNC_MINIO_BUCKET" \
    --arg endpoint "$MINIO_ENDPOINT" \
    --arg access "$LAMASYNC_MINIO_ROOT_USER" \
    --arg secret "$LAMASYNC_MINIO_ROOT_PASSWORD" \
    '{
      name: "dogfood-test",
      type: "sync",
      backend: "s3",
      s3Endpoint: $endpoint,
      s3Bucket: $bucket,
      s3AccessKeyId: $access,
      s3SecretAccessKey: $secret,
      s3Region: "us-east-1"
    }'
  )")
  log "folder response: $FOLDER_RESPONSE"
  FOLDER_ID=$(printf '%s' "$FOLDER_RESPONSE" | jq -r '.id')
  [ -n "$FOLDER_ID" ] && [ "$FOLDER_ID" != "null" ] || fail "could not create folder"

  log "assigning folder to ${LAMASYNC_HOSTNAME}..."
  ASSIGN_RESPONSE=$(call_api POST "/folders/${FOLDER_ID}/assign" "$(jq -n \
    --arg hostId "$LAMASYNC_HOSTNAME" \
    '{
      hostId: $hostId,
      role: "both",
      localPath: "/test-src",
      enabled: true,
      conflictStrategy: "newer_wins"
    }'
  )")
  log "assignment response: $ASSIGN_RESPONSE"

  log "refreshing daemon config..."
  socket_cmd '{"cmd":"status"}' | tee "$REPORT_DIR/daemon-status-before-sync.txt"

  run_tui "tui-after-assignment"
  snapshot "api-after-assignment"

  log "creating test file on daemon..."
  mkdir -p /test-src
  echo "hello lamasync dogfood" > "/test-src/hello.txt"

  log "triggering sync via daemon socket..."
  socket_cmd "{\"cmd\":\"sync\",\"folderId\":\"${FOLDER_ID}\"}" | tee "$REPORT_DIR/sync-result.txt"

  log "waiting for operations to settle..."
  for i in {1..30}; do
    op=$(call_api GET "/operations?folderId=${FOLDER_ID}&limit=5")
    if echo "$op" | jq -e '.[] | select(.status != "started")' >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  snapshot "api-after-sync"
  run_tui "tui-after-sync"
  socket_cmd '{"cmd":"list-ops"}' | tee "$REPORT_DIR/daemon-ops.txt"

  log "checking bucket contents..."
  mc ls -r testminio/"$LAMASYNC_MINIO_BUCKET" > "$REPORT_DIR/bucket-contents.txt" 2>&1 || true
  if mc ls -r testminio/"$LAMASYNC_MINIO_BUCKET" | grep -q hello.txt; then
    log "PASS: hello.txt found in bucket"
  else
    fail "hello.txt not found in bucket"
  fi

  log "all checks passed. report written to $REPORT_DIR"
}

main "$@"
