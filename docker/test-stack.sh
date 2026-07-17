#!/usr/bin/env bash
set -euo pipefail
# One-command dogfood test for LamaSync with a local S3/MinIO backend.
#
# Usage:
#   cd LamaSync
#   ./docker/test-stack.sh
#
# Requirements:
#   - Bun installed (bun run build)
#   - Docker with a working custom bridge network (legacy builder is fine)
#   - lamasync/test-base:bookworm-slim image built (see docker/build-test-base.sh)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ ! -f "docker/.env.test" ]; then
  echo "Creating docker/.env.test from example..."
  cp docker/.env.test.example docker/.env.test
  sed -i "s/LAMASYNC_API_KEY=.*/LAMASYNC_API_KEY=$(openssl rand -hex 32)/" docker/.env.test
  sed -i "s/LAMASYNC_MINIO_ROOT_USER=.*/LAMASYNC_MINIO_ROOT_USER=minio-$(openssl rand -hex 16)/" docker/.env.test
  sed -i "s/LAMASYNC_MINIO_ROOT_PASSWORD=.*/LAMASYNC_MINIO_ROOT_PASSWORD=minio-secret-$(openssl rand -hex 32)/" docker/.env.test
  echo "Review docker/.env.test, then re-run this script."
  exit 0
fi

echo "[test-stack] building binaries..."
bun run build

echo "[test-stack] building Docker images..."
docker compose -f docker/docker-compose.test.yml --env-file docker/.env.test build

echo "[test-stack] starting stack and running dogfood test..."
docker compose -f docker/docker-compose.test.yml --env-file docker/.env.test up --abort-on-container-exit

echo "[test-stack] copying report..."
mkdir -p /tmp/lamasync-dogfood-report
if docker cp lamasync-test-runner:/tmp/lamasync-dogfood-report/. /tmp/lamasync-dogfood-report/ 2>/dev/null; then
  echo "Report copied to /tmp/lamasync-dogfood-report"
fi

echo "[test-stack] done. Clean up with:"
echo "  docker compose -f docker/docker-compose.test.yml --env-file docker/.env.test down -v"
