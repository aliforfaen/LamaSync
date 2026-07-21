#!/usr/bin/env bash
set -euo pipefail

# Environment injected by docker-compose
SERVER_URL="${LAMASYNC_SERVER_URL:-http://server:8080}"
API_KEY="${LAMASYNC_API_KEY:-sandbox-api-key}"
HOSTNAME="${LAMASYNC_HOSTNAME:-sandbox-client}"
SOCKET_PATH="${LAMASYNC_SOCKET_PATH:-/home/testuser/lamasync.sock}"

CLIENT_CONFIG_DIR="/home/testuser/.config/lamasync"
CLIENT_CONFIG="${CLIENT_CONFIG_DIR}/client.toml"
BINARY_DIR="/home/testuser/.local/bin"
TEST_DATA_DIR="/home/testuser/test-data"
DOTFILES_DIR="/home/testuser/.config/testapp"

mkdir -p "${CLIENT_CONFIG_DIR}" "${BINARY_DIR}" "${TEST_DATA_DIR}" "${DOTFILES_DIR}"

# ---------------------------------------------------------------------------
# 1. Install the client from the published release
# ---------------------------------------------------------------------------
echo "==> Installing lamasyncd from GitHub release..."
chmod +x /home/testuser/install.sh
/home/testuser/install.sh \
  --server-url "${SERVER_URL}" \
  --api-key "${API_KEY}" \
  --hostname "${HOSTNAME}" \
  --with-tui

# Verify binaries
lamasyncd --version
lamasync-tui --version

# ---------------------------------------------------------------------------
# 2. Write client config
# ---------------------------------------------------------------------------
cat > "${CLIENT_CONFIG}" <<EOF
serverUrl = "${SERVER_URL}"
apiKey = "${API_KEY}"
hostname = "${HOSTNAME}"
EOF

# Helper: start daemon and wait for socket to exist
start_daemon() {
  echo "==> Starting lamasyncd in background..."
  lamasyncd > /home/testuser/lamasyncd.log 2>&1 &
  DAEMON_PID=$!

  # Wait for socket to exist (daemon is ready)
  for i in {1..30}; do
    if [ -S "${SOCKET_PATH}" ]; then
      echo "==> Daemon socket ready"
      break
    fi
    sleep 1
  done
  if [ ! -S "${SOCKET_PATH}" ]; then
    echo "ERROR: daemon socket did not appear" >&2
    tail -n 50 /home/testuser/lamasyncd.log >&2
    exit 1
  fi
}

stop_daemon() {
  echo "==> Stopping daemon (pid ${DAEMON_PID})..."
  kill "${DAEMON_PID}" 2>/dev/null || true
  wait "${DAEMON_PID}" 2>/dev/null || true
  rm -f "${SOCKET_PATH}"
}

# Cleanup on exit
trap 'stop_daemon' EXIT

# Start daemon to register and get host ID
start_daemon

# Wait for daemon to register itself
for i in {1..30}; do
  if curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/health" | jq -e ".hosts[] | select(.hostname == \"${HOSTNAME}\")" > /dev/null; then
    echo "==> Host registered on server"
    break
  fi
  sleep 1
done

HOST_ID=$(curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/health" | jq -r ".hosts[] | select(.hostname == \"${HOSTNAME}\") | .id")
if [ -z "${HOST_ID}" ] || [ "${HOST_ID}" = "null" ]; then
  echo "ERROR: host did not register" >&2
  exit 1
fi
echo "==> Host ID: ${HOST_ID}"

# Stop daemon so we can configure all folders/manifests before the next start
stop_daemon

# ---------------------------------------------------------------------------
# 3. Create normal backup test data and server-side folder/assignment
# ---------------------------------------------------------------------------
echo "==> Creating normal backup test data..."
mkdir -p "${TEST_DATA_DIR}/photos" "${TEST_DATA_DIR}/docs"
echo "photo1" > "${TEST_DATA_DIR}/photos/photo1.jpg"
echo "photo2" > "${TEST_DATA_DIR}/photos/photo2.jpg"
echo "doc1" > "${TEST_DATA_DIR}/docs/readme.txt"
mkdir -p "${TEST_DATA_DIR}/nested/deep"
echo "deep file" > "${TEST_DATA_DIR}/nested/deep/file.txt"
# File with special characters
echo "special" > "${TEST_DATA_DIR}/special chars & more.txt"

echo "==> Creating backup folder on server..."
BACKUP_FOLDER=$(curl -fsSL -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  "${SERVER_URL}/api/v1/folders" \
  -d '{"name":"sandbox-backup","type":"backup","backend":"local"}' | jq -r '.id')
echo "==> Backup folder ID: ${BACKUP_FOLDER}"

echo "==> Assigning backup folder to client..."
curl -fsSL -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  "${SERVER_URL}/api/v1/folders/${BACKUP_FOLDER}/assign" \
  -d "{\"hostId\":\"${HOST_ID}\",\"role\":\"source\",\"localPath\":\"${TEST_DATA_DIR}\",\"syncExpr\":\"*/1 * * * *\"}" > /dev/null

# ---------------------------------------------------------------------------
# 4. Create dotfile test data and server-side folder/manifest
# ---------------------------------------------------------------------------
echo "==> Creating dotfile test data..."
cat > "${DOTFILES_DIR}/settings.json" <<EOF
{"theme":"dark","font":"monospace"}
EOF
echo "alias ll='ls -la'" > "${DOTFILES_DIR}/aliases"

echo "==> Creating dotfile folder on server..."
DOTFILE_FOLDER=$(curl -fsSL -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  "${SERVER_URL}/api/v1/folders" \
  -d '{"name":"sandbox-dotfiles","type":"dotfile","backend":"local"}' | jq -r '.id')
echo "==> Dotfile folder ID: ${DOTFILE_FOLDER}"

echo "==> Assigning dotfile folder to client..."
curl -fsSL -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  "${SERVER_URL}/api/v1/folders/${DOTFILE_FOLDER}/assign" \
  -d "{\"hostId\":\"${HOST_ID}\",\"role\":\"source\",\"localPath\":\"${DOTFILES_DIR}\",\"syncExpr\":\"*/1 * * * *\"}" > /dev/null

echo "==> Creating dotfile manifest..."
curl -fsSL -X POST -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  "${SERVER_URL}/api/v1/dotfiles/manifests" \
  -d "{\"hostId\":\"${HOST_ID}\",\"appName\":\"sandbox-dotfiles\",\"paths\":[\"${DOTFILES_DIR}\"],\"excludes\":[\"*.log\"]}" > /dev/null

# Restart daemon so it picks up all the new config in one go
start_daemon

# ---------------------------------------------------------------------------
# 5. Trigger sync-all and verify operations
# ---------------------------------------------------------------------------
echo "==> Triggering sync-all..."
/home/testuser/socket-send.py --socket "${SOCKET_PATH}" --cmd sync-all

echo "==> Waiting for backup operation to complete..."
for i in {1..30}; do
  STATUS=$(curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?folderId=${BACKUP_FOLDER}&hostId=${HOST_ID}" | jq -r '.[0].status // empty')
  if [ "${STATUS}" = "success" ]; then
    echo "==> Backup operation succeeded"
    break
  elif [ "${STATUS}" = "failed" ]; then
    echo "ERROR: backup operation failed" >&2
    curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?folderId=${BACKUP_FOLDER}&hostId=${HOST_ID}" | jq '.' >&2
    exit 1
  fi
  sleep 2
done

if [ "${STATUS}" != "success" ]; then
  echo "ERROR: backup operation did not report success in time" >&2
  curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?folderId=${BACKUP_FOLDER}&hostId=${HOST_ID}" | jq '.' >&2
  exit 1
fi

echo "==> Waiting for dotfile operation to complete..."
for i in {1..30}; do
  STATUS=$(curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?folderId=${DOTFILE_FOLDER}&hostId=${HOST_ID}" | jq -r '.[0].status // empty')
  if [ "${STATUS}" = "success" ]; then
    echo "==> Dotfile operation succeeded"
    break
  elif [ "${STATUS}" = "failed" ]; then
    echo "ERROR: dotfile operation failed" >&2
    curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?folderId=${DOTFILE_FOLDER}&hostId=${HOST_ID}" | jq '.' >&2
    exit 1
  fi
  sleep 2
done

if [ "${STATUS}" != "success" ]; then
  echo "ERROR: dotfile operation did not report success in time" >&2
  curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?folderId=${DOTFILE_FOLDER}&hostId=${HOST_ID}" | jq '.' >&2
  exit 1
fi

echo "==> Verifying dotfile tarball on server..."
if curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/dotfiles/manifests?hostId=${HOST_ID}" | jq -e '.[] | select(.appName == "sandbox-dotfiles")' > /dev/null; then
  echo "==> Dotfile manifest exists on server"
else
  echo "ERROR: dotfile manifest not found on server" >&2
  exit 1
fi

VERSIONS=$(curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/dotfiles/sandbox-dotfiles" | jq -r '.[].id')
if [ -z "${VERSIONS}" ] || [ "${VERSIONS}" = "null" ]; then
  echo "ERROR: no dotfile versions found on server" >&2
  exit 1
fi
echo "==> Dotfile version(s): ${VERSIONS}"

# ---------------------------------------------------------------------------
# 6. Print logs and summary
# ---------------------------------------------------------------------------
echo ""
echo "==> Client daemon log (tail):"
tail -n 80 /home/testuser/lamasyncd.log

echo ""
echo "==> Server operation log:"
curl -fsSL -H "Authorization: Bearer ${API_KEY}" "${SERVER_URL}/api/v1/operations?hostId=${HOST_ID}" | jq '.'

echo ""
echo "==> TEST SUMMARY"
echo "Host:        ${HOST_ID} (${HOSTNAME})"
echo "Backup op:   success"
echo "Dotfile op:  success"
echo "Client log:  /home/testuser/lamasyncd.log"
echo "Server logs: docker logs lamasync-server-sandbox"
