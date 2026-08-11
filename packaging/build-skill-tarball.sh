#!/usr/bin/env bash
# build-skill-tarball.sh — pack `packages/agent-skill/` (SKILL.md +
# reference/) into a single tarball that becomes a release asset:
#   lamasync-skill-<version>.tar.gz
#
# The skill ships separately from the binaries so the agent runtime can
# update it independently — but the daemon's `--update skill` matches the
# asset name to the running binary's VERSION, so cross-version drift is
# structurally impossible.
#
# Usage:
#   ./packaging/build-skill-tarball.sh [<output-dir>]
#
# Output lands in <output-dir>/lamasync-skill-<version>.tar.gz.
# Default output-dir: ./dist/ (CI uses ./dist/).

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_SRC="${REPO}/packages/agent-skill"
VERSION_FILE="${REPO}/packages/core/src/version.ts"

# Mirror scripts/gen-version.ts' extraction so we don't have to import a
# generated file at packaging time. Falls back to a git tag if the TS
# file is unreadable (rare in CI; the typecheck step makes sure the
# generator runs first).
VERSION="$(grep -oE 'export const VERSION = "[^"]+"' "${VERSION_FILE}" \
  | head -n1 \
  | sed -E 's/.*"([^"]+)".*/\1/')"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(git -C "${REPO}" describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "0.0.0")"
fi

OUTPUT_DIR="${1:-${REPO}/dist}"
mkdir -p "${OUTPUT_DIR}"

ARCHIVE_NAME="lamasync-skill-${VERSION}.tar.gz"
ARCHIVE_PATH="${OUTPUT_DIR}/${ARCHIVE_NAME}"

# Stage the bundle in a temp dir so the tarball's top-level layout is
# stable. `--transform` could do this in one shot, but staging makes the
# contents trivially auditable.
STAGE_DIR="$(mktemp -d -t lamasync-skill.XXXXXX)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

BUNDLE_DIR="${STAGE_DIR}/lamasync-skill-${VERSION}"
mkdir -p "${BUNDLE_DIR}"

# SKILL.md must exist (the trigger description). The reference/ subdir is
# optional at packaging time but every shipped release carries it.
if [[ ! -f "${SKILL_SRC}/SKILL.md" ]]; then
  echo "build-skill-tarball.sh: missing ${SKILL_SRC}/SKILL.md" >&2
  exit 2
fi
cp "${SKILL_SRC}/SKILL.md" "${BUNDLE_DIR}/SKILL.md"

if [[ -d "${SKILL_SRC}/reference" ]]; then
  cp -R "${SKILL_SRC}/reference" "${BUNDLE_DIR}/reference"
fi

# The daemon's `lamasyncd --check-update` / `--update skill` reads this to
# report the installed skill version (skill-update.ts readInstalledSkillVersion).
printf '%s\n' "${VERSION}" > "${BUNDLE_DIR}/VERSION"

# Ship the unchanged `lamasync-client.md` alongside (the separate
# client-onboarding skill).
if [[ -f "${SKILL_SRC}/lamasync-client.md" ]]; then
  cp "${SKILL_SRC}/lamasync-client.md" "${BUNDLE_DIR}/lamasync-client.md"
fi

tar -czf "${ARCHIVE_PATH}" -C "${STAGE_DIR}" "lamasync-skill-${VERSION}"

# Print a single line that the CI release job can parse.
echo "skill-tarball: ${ARCHIVE_PATH} ($(stat -c%s "${ARCHIVE_PATH}" 2>/dev/null || stat -f%z "${ARCHIVE_PATH}") bytes, version=${VERSION})"
