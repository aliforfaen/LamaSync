#!/usr/bin/env bash
# scripts/test-update.sh — test the curl-to-bash update path in Docker.
#
# Stages a fake GitHub release (mock API + fake binaries), installs an old
# lamasyncd, then runs update.sh via curl | bash and verifies the binaries are
# replaced with the newer release.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NETWORK="lamasync-update-test"
SERVER_NAME="lamasync-update-server"
CLIENT_NAME="lamasync-update-client"

cleanup() {
  echo "[cleanup] removing containers and network..."
  docker rm -f "$CLIENT_NAME" "$SERVER_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$ROOT/tmp/update-test"
}
trap cleanup INT TERM EXIT

echo "[setup] Preparing test release server..."
TEST_DIR="$ROOT/tmp/update-test"
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"

# Fake "old" binary (installed version 0.1.0).
cat > "$TEST_DIR/lamasyncd-old" <<'EOF'
#!/bin/sh
echo "lamasyncd 0.1.0"
EOF
chmod +x "$TEST_DIR/lamasyncd-old"

# Fake "new" release binary (version 99.99.99).
cat > "$TEST_DIR/lamasyncd" <<'EOF'
#!/bin/sh
echo "lamasyncd 99.99.99"
EOF
chmod +x "$TEST_DIR/lamasyncd"

# Fake TUI release binary.
cat > "$TEST_DIR/lamasync-tui" <<'EOF'
#!/bin/sh
echo "lamasync-tui 99.99.99"
EOF
chmod +x "$TEST_DIR/lamasync-tui"

# Copy updater script.
cp "$ROOT/packaging/install/update.sh" "$TEST_DIR/update.sh"

# Mock GitHub releases API JSON.
cat > "$TEST_DIR/releases.json" <<'EOF'
{"tag_name":"v99.99.99","published_at":"2026-01-01T00:00:00Z","assets":[]}
EOF

# Nginx config that serves the mock API at the GitHub releases path.
cat > "$TEST_DIR/nginx.conf" <<'EOF'
server {
  listen 80;
  server_name localhost;
  root /usr/share/nginx/html;
  location / {
    try_files $uri $uri/ =404;
  }
  location = /repos/aliforfaen/LamaSync/releases/latest {
    default_type application/json;
    alias /usr/share/nginx/html/releases.json;
  }
}
EOF

echo "[docker] Creating network ${NETWORK}..."
docker network rm "$NETWORK" >/dev/null 2>&1 || true
docker network create "$NETWORK" >/dev/null

echo "[docker] Starting local release server..."
SERVER_CID=$(docker run -d --rm \
  --name "$SERVER_NAME" \
  --network "$NETWORK" \
  -v "$TEST_DIR:/usr/share/nginx/html:ro" \
  -v "$TEST_DIR/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine)

# Wait for nginx to be ready.
for i in $(seq 1 30); do
  if docker run --rm --network "$NETWORK" curlimages/curl \
    -fsSL "http://$SERVER_NAME/update.sh" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[docker] Running update test in fresh Debian container..."
docker run --rm \
  --name "$CLIENT_NAME" \
  --network "$NETWORK" \
  -e LAMASYNC_GITHUB_API="http://$SERVER_NAME/repos/aliforfaen/LamaSync/releases/latest" \
  -e LAMASYNC_INSTALL_BASE_URL="http://$SERVER_NAME" \
  debian:bookworm-slim \
  bash -c "
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq curl >/dev/null
    mkdir -p /root/.local/bin
    echo '[client] Installing old lamasyncd from test server...'
    curl -fsSL http://$SERVER_NAME/lamasyncd-old -o /root/.local/bin/lamasyncd
    chmod +x /root/.local/bin/lamasyncd
    echo '[client] Installed version:'
    /root/.local/bin/lamasyncd --version
    echo '[client] Running update.sh...'
    curl -sSL http://$SERVER_NAME/update.sh | bash -s -- --yes
    echo '[client] Verifying update...'
    /root/.local/bin/lamasyncd --version
    /root/.local/bin/lamasync-tui --version
    /root/.local/bin/lamasyncd --version | grep -q '99.99.99'
    /root/.local/bin/lamasync-tui --version | grep -q '99.99.99'
    echo '[client] Update checks passed.'
  "

echo ""
echo "==> Update test passed."
