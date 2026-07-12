#!/usr/bin/env bash
# install.sh — install lamasyncd on a Linux client.
#
# Usage:
#   curl -sSL https://github.com/aliforfaen/LamaSync/releases/latest/download/install.sh | bash -s -- \
#     --server-url http://100.64.0.1:8080 \
#     --api-key <your-key> \
#     [--hostname myhost]
#
# Or run locally:
#   ./install.sh --server-url http://100.64.0.1:8080 --api-key dev-key

set -euo pipefail

REPO="aliforfaen/LamaSync"
INSTALL_DIR="${HOME}/.local/bin"
CONFIG_DIR="${HOME}/.config/lamasync"
SERVICE_DIR="${HOME}/.config/systemd/user"
SOCKET_PATH="${LAMASYNC_SOCKET_PATH:-${HOME}/lamasync.sock}"

SERVER_URL=""
API_KEY=""
HOSTNAME_VAL="$(hostname)"

usage() {
  cat <<EOF
Usage: $0 --server-url URL --api-key KEY [--hostname NAME]

Options:
  --server-url URL    Base URL of the lamasync-server (e.g., http://100.64.0.1:8080)
  --api-key KEY       Pre-shared API key
  --hostname NAME     Override hostname (default: $(hostname))
  -h, --help          Show this help

Environment:
  LAMASYNC_SOCKET_PATH  Override the Unix socket path (default: ~/lamasync.sock)
EOF
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --api-key)    API_KEY="$2"; shift 2 ;;
    --hostname)   HOSTNAME_VAL="$2"; shift 2 ;;
    -h|--help)    usage 0 ;;
    *)            echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "$SERVER_URL" || -z "$API_KEY" ]]; then
  echo "Error: --server-url and --api-key are required" >&2
  usage 1
fi

# Detect arch → asset suffix
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH_SUFFIX="x86_64-unknown-linux-gnu" ;;
  aarch64) ARCH_SUFFIX="aarch64-unknown-linux-gnu" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 2
    ;;
esac

ASSET="lamasyncd-${ARCH_SUFFIX}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

echo "==> Installing lamasyncd to ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$SERVICE_DIR"

# Download (fall back to local build if release not available)
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsSL -o "${INSTALL_DIR}/lamasyncd" "$DOWNLOAD_URL"; then
    echo "Warning: release asset not found, falling back to ./packages/daemon/dist/lamasyncd" >&2
    if [[ -f "./packages/daemon/dist/lamasyncd" ]]; then
      cp "./packages/daemon/dist/lamasyncd" "${INSTALL_DIR}/lamasyncd"
    else
      echo "Error: no local binary and no release available" >&2
      exit 3
    fi
  fi
else
  echo "Error: curl is required" >&2
  exit 4
fi
chmod +x "${INSTALL_DIR}/lamasyncd"

# Write client config
cat > "${CONFIG_DIR}/client.toml" <<EOF
serverUrl = "${SERVER_URL}"
apiKey = "${API_KEY}"
hostname = "${HOSTNAME_VAL}"
EOF
chmod 600 "${CONFIG_DIR}/client.toml"

# Install systemd user unit
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/../systemd/lamasyncd.service" "${SERVICE_DIR}/lamasyncd.service"

# Enable lingering so the user service runs without an active session
if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$(id -u)" 2>/dev/null || true
fi

# Reload systemd and start
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload
  systemctl --user enable lamasyncd.service
  systemctl --user restart lamasyncd.service
  echo "==> Started lamasyncd via systemd --user"
  echo "    Status: systemctl --user status lamasyncd"
  echo "    Logs:   journalctl --user -u lamasyncd -f"
else
  echo "systemctl not available; start manually: ${INSTALL_DIR}/lamasyncd" >&2
fi

echo "==> Done."
echo "    Config: ${CONFIG_DIR}/client.toml"
echo "    Binary: ${INSTALL_DIR}/lamasyncd"
echo "    Socket: ${SOCKET_PATH}"
