#!/usr/bin/env bash
set -euo pipefail
# Builds the lamasync/test-base image used by the local test Dockerfiles.
# This needs outbound network access, so it runs the container with --network=host.

docker run --name lamasync-test-base --network=host debian:bookworm-slim bash -c "
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip tini socat netcat-openbsd bash jq
curl -fsSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc
chmod +x /usr/local/bin/mc
curl -fsSL 'https://github.com/rclone/rclone/releases/download/v1.68.2/rclone-v1.68.2-linux-amd64.zip' -o /tmp/rclone.zip
unzip /tmp/rclone.zip -d /tmp/
install -m 0755 /tmp/rclone-v1.68.2-linux-amd64/rclone /usr/local/bin/rclone
rm -rf /tmp/rclone.zip /tmp/rclone-v1.68.2-linux-amd64
rm -rf /var/lib/apt/lists/*
"

docker commit lamasync-test-base lamasync/test-base:bookworm-slim
docker rm lamasync-test-base
echo "Built lamasync/test-base:bookworm-slim"
