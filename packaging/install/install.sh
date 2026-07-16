#!/usr/bin/env bash
# install.sh — install lamasyncd on a Linux client.
#
# Usage:
#   curl -sSL https://github.com/aliforfaen/LamaSync/releases/latest/download/install.sh | bash -s -- \
#     --server-url http://100.64.0.1:8080 \
#     --api-key <your-key> \
#     [--hostname myhost] \
#     [--with-tui] \
#     [--binary-dir ~/.local/bin] \
#     [--check]
#
# Or run locally:
#   ./install.sh --server-url http://100.64.0.1:8080 --api-key dev-key
#
# --check fetches the latest release and compares with the locally installed
# lamasyncd (if any); it never writes to disk. Useful for unattended cron
# health checks.

set -euo pipefail

REPO="aliforfaen/LamaSync"
DEFAULT_BINARY_DIR="${HOME}/.local/bin"
BINARY_DIR="${DEFAULT_BINARY_DIR}"
CONFIG_DIR="${HOME}/.config/lamasync"
SERVICE_DIR="${HOME}/.config/systemd/user"
SOCKET_PATH="${LAMASYNC_SOCKET_PATH:-${HOME}/lamasync.sock}"

SERVER_URL=""
API_KEY=""
HOSTNAME_VAL="$(hostname)"
WITH_TUI=0
CHECK_ONLY=0
PRINT_VERSION=0

usage() {
  cat <<EOF
Usage: $0 --server-url URL --api-key KEY [options]

Required:
  --server-url URL    Base URL of the lamasync-server (e.g., http://100.64.0.1:8080)
  --api-key KEY       Pre-shared API key

Options:
  --hostname NAME     Override hostname (default: $(hostname))
  --with-tui          Also install the lamasync-tui binary to BINARY_DIR
  --binary-dir DIR    Install binaries into DIR (default: ~/.local/bin)
  --check             Only check for updates; never write to disk
  --version           Print installer version (0.2.0) and exit
  -h, --help          Show this help

Environment:
  LAMASYNC_SOCKET_PATH  Override the Unix socket path (default: ~/lamasync.sock)
EOF
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server-url)  SERVER_URL="$2"; shift 2 ;;
    --api-key)     API_KEY="$2"; shift 2 ;;
    --hostname)    HOSTNAME_VAL="$2"; shift 2 ;;
    --with-tui)    WITH_TUI=1; shift ;;
    --binary-dir)  BINARY_DIR="$2"; shift 2 ;;
    --check)       CHECK_ONLY=1; shift ;;
    --version)     PRINT_VERSION=1; shift ;;
    -h|--help)     usage 0 ;;
    *)             echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [[ "${PRINT_VERSION}" -eq 1 ]]; then
  echo "install.sh 0.2.0"
  exit 0
fi

if [[ "${CHECK_ONLY}" -eq 1 ]]; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "Error: curl is required for --check" >&2
    exit 4
  fi
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
  echo "==> Fetching latest release info from ${API_URL}"
  RELEASE_JSON="$(curl -fsSL "${API_URL}")" || {
    echo "Error: failed to query GitHub Releases API" >&2
    exit 5
  }
  LATEST_VERSION="$(printf '%s' "${RELEASE_JSON}" \
    | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -n1 \
    | sed -E 's/.*"([^"]*)".*/\1/')"
  if [[ -z "${LATEST_VERSION}" ]]; then
    echo "Error: could not parse latest version from release JSON" >&2
    exit 5
  fi
  LOCAL_VERSION=""
  if command -v lamasyncd >/dev/null 2>&1; then
    LOCAL_VERSION="$(lamasyncd --version 2>/dev/null \
      | awk '{print $NF}' || true)"
  fi
  echo "    Latest:  ${LATEST_VERSION}"
  if [[ -n "${LOCAL_VERSION}" ]]; then
    echo "    Installed: ${LOCAL_VERSION}"
    if [[ "${LATEST_VERSION}" == "${LOCAL_VERSION}" ]]; then
      echo "==> Already up to date."
      exit 0
    fi
    echo "==> Update available."
    exit 10
  fi
  echo "    Installed: (none found in PATH)"
  echo "==> No install detected; run this script with --server-url/--api-key to install."
  exit 11
fi

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

echo "==> Installing lamasyncd to ${BINARY_DIR}"
mkdir -p "$BINARY_DIR"
mkdir -p "$CONFIG_DIR"
mkdir -p "$SERVICE_DIR"

# Download (fall back to local build if release not available)
if command -v curl >/dev/null 2>&1; then
  if ! curl -fsSL -o "${BINARY_DIR}/lamasyncd" "$DOWNLOAD_URL"; then
    echo "Warning: release asset not found, falling back to ./packages/daemon/dist/lamasyncd" >&2
    if [[ -f "./packages/daemon/dist/lamasyncd" ]]; then
      cp "./packages/daemon/dist/lamasyncd" "${BINARY_DIR}/lamasyncd"
    else
      echo "Error: no local binary and no release available" >&2
      exit 3
    fi
  fi
else
  echo "Error: curl is required" >&2
  exit 4
fi
chmod +x "${BINARY_DIR}/lamasyncd"

# Optionally install the TUI companion binary.
if [[ "${WITH_TUI}" -eq 1 ]]; then
  TUI_ASSET="lamasync-tui-${ARCH_SUFFIX}"
  TUI_URL="https://github.com/${REPO}/releases/latest/download/${TUI_ASSET}"
  echo "==> Installing lamasync-tui to ${BINARY_DIR}"
  if ! curl -fsSL -o "${BINARY_DIR}/lamasync-tui" "$TUI_URL"; then
    echo "Warning: ${TUI_ASSET} not found in latest release, falling back to ./packages/tui/dist/lamasync-tui" >&2
    if [[ -f "./packages/tui/dist/lamasync-tui" ]]; then
      cp "./packages/tui/dist/lamasync-tui" "${BINARY_DIR}/lamasync-tui"
    else
      echo "Error: TUI binary not available locally and no release asset found" >&2
      exit 3
    fi
  fi
  chmod +x "${BINARY_DIR}/lamasync-tui"
fi

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
  echo "systemctl not available; start manually: ${BINARY_DIR}/lamasyncd" >&2
fi

echo "==> Done."
echo "    Config: ${CONFIG_DIR}/client.toml"
echo "    Binary: ${BINARY_DIR}/lamasyncd"
if [[ "${WITH_TUI}" -eq 1 ]]; then
  echo "    TUI:    ${BINARY_DIR}/lamasync-tui"
fi
echo "    Socket: ${SOCKET_PATH}"
echo ""
echo "==> Hint: future updates can be applied without re-running this script:"
echo "    ${BINARY_DIR}/lamasyncd --update"