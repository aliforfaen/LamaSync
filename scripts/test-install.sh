#!/usr/bin/env bash
# scripts/test-install.sh — test the curl-to-bash install path in Docker.
#
# Builds the daemon + TUI binaries, starts a tiny local "release" HTTP server,
# then runs the install script in a fresh Debian container via curl | bash.
# Verifies that the binary, config, and systemd unit are written correctly.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NETWORK="lamasync-install-test"
SERVER_NAME="lamasync-install-server"
CLIENT_NAME="lamasync-install-client"
TEST_PORT="9876"

cleanup() {
  echo "[cleanup] removing containers and network..."
  docker rm -f "$CLIENT_NAME" "$SERVER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$ROOT/tmp/install-test"
}
trap cleanup INT TERM EXIT

echo "[build] Building lamasync binaries..."
if [ ! -f "$ROOT/packages/daemon/dist/lamasyncd" ] || [ ! -f "$ROOT/packages/tui/dist/lamasync-tui" ]; then
  bun run build
fi

echo "[setup] Preparing test web root..."
TEST_DIR="$ROOT/tmp/install-test"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
cp "$ROOT/packages/daemon/dist/lamasyncd" "$TEST_DIR/lamasyncd"
cp "$ROOT/packages/tui/dist/lamasync-tui" "$TEST_DIR/lamasync-tui"
cp "$ROOT/packaging/install/install.sh" "$TEST_DIR/install.sh"

echo "[docker] Creating network ${NETWORK}..."
docker network rm "$NETWORK" >/dev/null 2>&1 || true
docker network create "$NETWORK" >/dev/null

echo "[docker] Starting local release server..."
SERVER_CID=$(docker run -d --rm \
  --name "$SERVER_NAME" \
  --network "$NETWORK" \
  -v "$TEST_DIR:/usr/share/nginx/html:ro" \
  nginx:alpine)

# Wait for nginx to be ready.
for i in $(seq 1 30); do
  if docker run --rm --network "$NETWORK" curlimages/curl \
    -fsSL "http://$SERVER_NAME/install.sh" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[docker] Running curl-to-bash install in fresh Debian container..."
docker run --rm \
  --name "$CLIENT_NAME" \
  --network "$NETWORK" \
  -e LAMASYNC_INSTALL_BASE_URL="http://$SERVER_NAME" \
  debian:bookworm-slim \
  bash -c "
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq curl >/dev/null
    echo '[client] Downloading install script from test server...'
    curl -sSL http://$SERVER_NAME/install.sh | bash -s -- \
      --server-url http://lamasync-server:8080 \
      --api-key test-install-key \
      --hostname install-test-host \
      --with-tui
    echo '[client] Verifying install...'
    ~/.local/bin/lamasyncd --version
    ~/.local/bin/lamasync-tui --version
    grep -q 'serverUrl = \"http://lamasync-server:8080\"' ~/.config/lamasync/client.toml
    grep -q 'apiKey = \"test-install-key\"' ~/.config/lamasync/client.toml
    grep -q 'ExecStart=/root/.local/bin/lamasyncd' ~/.config/systemd/user/lamasyncd.service
    grep -q 'LAMASYNC_SOCKET_PATH=/root/lamasync.sock' ~/.config/systemd/user/lamasyncd.service
    echo '[client] All install checks passed.'
  "

echo ""
echo "==> Install test passed."
