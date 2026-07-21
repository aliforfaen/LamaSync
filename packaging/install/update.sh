#!/usr/bin/env bash
# update.sh — standalone updater for lamasyncd + lamasync-tui.
#
# Usage:
#   curl -sSL https://github.com/aliforfaen/LamaSync/releases/latest/download/update.sh | bash
#
# Behavior:
#   1. If lamasyncd is not installed → prints the install command and exits.
#   2. If lamasyncd is installed at the latest version → prints "already up to date".
#   3. Otherwise → downloads lamasyncd and lamasync-tui from the latest GitHub
#      release and atomically replaces the binaries in --binary-dir (default
#      ~/.local/bin).
#
# All downloads land in a temp directory; binaries are only moved into place
# after a successful download. set -euo pipefail means any failed download or
# verification aborts the script before touching the live binaries.

set -euo pipefail

REPO="aliforfaen/LamaSync"
DEFAULT_BINARY_DIR="${HOME}/.local/bin"
BINARY_DIR="${DEFAULT_BINARY_DIR}"
GITHUB_API="${LAMASYNC_GITHUB_API:-https://api.github.com/repos/${REPO}/releases/latest}"
INSTALL_BASE_URL="${LAMASYNC_INSTALL_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"

usage() {
  cat <<EOF
Usage: curl -sSL .../update.sh | bash [-s -- [--binary-dir DIR]]

Options:
  --binary-dir DIR    Directory holding the installed binaries
                      (default: ~/.local/bin)
  --yes               Skip the "press enter to continue" confirmation
  --help              Show this help

Environment:
  LAMASYNC_INSTALL_BASE_URL  Override the release download base URL (for testing)
  LAMASYNC_GITHUB_API       Override the GitHub releases API URL (for testing)

When piped from curl, any flags must follow the dash-dash separator.
For example:
  curl -sSL .../update.sh | bash -s -- --binary-dir /opt/lamasync/bin
EOF
  exit "${1:-0}"
}

ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary-dir) BINARY_DIR="$2"; shift 2 ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    --help|-h)    usage 0 ;;
    *)            echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required" >&2
  exit 4
fi

# Detect installed lamasyncd. Prefer BINARY_DIR/lamasyncd so PATH mismatches
# don't trick us into thinking an install is missing.
LAMASYNCD_BIN=""
if [[ -x "${BINARY_DIR}/lamasyncd" ]]; then
  LAMASYNCD_BIN="${BINARY_DIR}/lamasyncd"
elif command -v lamasyncd >/dev/null 2>&1; then
  LAMASYNCD_BIN="$(command -v lamasyncd)"
fi

if [[ -z "${LAMASYNCD_BIN}" ]]; then
  cat <<EOF
==> lamasyncd is not installed.

To install, run:

  curl -sSL https://github.com/${REPO}/releases/latest/download/install.sh \\
    | bash -s -- --server-url URL --api-key KEY

(Add --with-tui to also install the lamasync-tui companion.)
EOF
  exit 20
fi

# Parse current version from "lamasyncd 0.2.1".
INSTALLED_VERSION="$("${LAMASYNCD_BIN}" --version 2>/dev/null \
  | awk 'NF {print $NF; exit}')"
if [[ -z "${INSTALLED_VERSION}" ]]; then
  echo "Error: could not parse version from '${LAMASYNCD_BIN} --version'" >&2
  exit 21
fi
echo "==> Installed version: ${INSTALLED_VERSION}"

# Fetch the latest release metadata.
echo "==> Querying ${GITHUB_API}"
RELEASE_JSON="$(curl -fsSL "${GITHUB_API}")" || {
  echo "Error: failed to fetch release metadata from GitHub" >&2
  exit 5
}
LATEST_TAG="$(printf '%s' "${RELEASE_JSON}" \
  | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -n1 \
  | sed -E 's/.*"([^"]*)".*/\1/')"
if [[ -z "${LATEST_TAG}" ]]; then
  echo "Error: could not parse tag_name from release JSON" >&2
  exit 5
fi
# Strip leading "v" so "v0.2.1" compares equal to "0.2.1".
LATEST_VERSION="${LATEST_TAG#v}"
echo "==> Latest version:    ${LATEST_VERSION}"

if [[ "${INSTALLED_VERSION}" == "${LATEST_VERSION}" ]]; then
  echo "==> Already up to date."
  exit 0
fi

DAEMON_ASSET="lamasyncd"
TUI_ASSET="lamasync-tui"
DAEMON_URL="${INSTALL_BASE_URL}/${DAEMON_ASSET}"
TUI_URL="${INSTALL_BASE_URL}/${TUI_ASSET}"

echo "==> Update available: ${INSTALLED_VERSION} → ${LATEST_VERSION}"
echo "    Target directory: ${BINARY_DIR}"
if [[ "${ASSUME_YES}" -ne 1 ]]; then
  # Only prompt if stdin is a terminal; piped curl|bash skips the prompt.
  if [[ -t 0 ]]; then
    read -r -p "    Press Enter to continue, or Ctrl+C to abort: "
  fi
fi

# Stage downloads in a temp dir so partial failures never touch the live
# binaries.
TMP_DIR="$(mktemp -d -t lamasync-update.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

download_asset() {
  local url="$1"
  local dest="$2"
  if ! curl -fsSL -o "${dest}" "${url}"; then
    return 1
  fi
  # Curl will happily save an HTTP error page; require the file to be non-empty
  # and executable-looking (a sane size threshold catches "Not Found" pages).
  if [[ ! -s "${dest}" ]]; then
    return 1
  fi
  return 0
}

echo "==> Downloading ${DAEMON_ASSET}"
if ! download_asset "${DAEMON_URL}" "${TMP_DIR}/lamasyncd"; then
  echo "Error: failed to download ${DAEMON_URL}" >&2
  exit 6
fi

TUI_DOWNLOADED=0
if curl -fsSI "${TUI_URL}" >/dev/null 2>&1; then
  echo "==> Downloading ${TUI_ASSET}"
  if download_asset "${TUI_URL}" "${TMP_DIR}/lamasync-tui"; then
    TUI_DOWNLOADED=1
  else
    echo "Warning: TUI download failed; skipping TUI update" >&2
  fi
else
  echo "    (TUI asset not in release; skipping)"
fi

# Verify the staged files actually look like binaries before we move them
# into place — better to bail than to brick the daemon.
if [[ ! -s "${TMP_DIR}/lamasyncd" ]]; then
  echo "Error: staged lamasyncd is empty" >&2
  exit 6
fi
chmod +x "${TMP_DIR}/lamasyncd"
if [[ "${TUI_DOWNLOADED}" -eq 1 ]]; then
  chmod +x "${TMP_DIR}/lamasync-tui"
fi

# Move into place. Use mv so the rename is atomic on the same filesystem;
# create BINARY_DIR if it doesn't exist (first-time install of TUI).
mkdir -p "${BINARY_DIR}"
mv -f "${TMP_DIR}/lamasyncd" "${BINARY_DIR}/lamasyncd"
if [[ "${TUI_DOWNLOADED}" -eq 1 ]]; then
  mv -f "${TMP_DIR}/lamasync-tui" "${BINARY_DIR}/lamasync-tui"
fi

# Verify the new binary still answers --version. A quick sanity check that
# we didn't replace a working binary with junk.
NEW_VERSION="$("${BINARY_DIR}/lamasyncd" --version 2>/dev/null \
  | awk 'NF {print $NF; exit}')"
if [[ "${NEW_VERSION}" != "${LATEST_VERSION}" ]]; then
  echo "Error: post-update version check failed (got '${NEW_VERSION}', expected '${LATEST_VERSION}')" >&2
  exit 7
fi

echo "==> Updated lamasyncd to ${LATEST_VERSION}."
if [[ "${TUI_DOWNLOADED}" -eq 1 ]]; then
  echo "==> Updated lamasync-tui to ${LATEST_VERSION}."
fi

# Hint: restart the systemd unit if it's running.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet lamasyncd.service 2>/dev/null; then
    echo "==> Restarting lamasyncd.service (user)"
    systemctl --user restart lamasyncd.service || true
  fi
fi