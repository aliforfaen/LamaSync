FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# Install the basics we need for install + testing
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    ca-certificates \
    curl \
    jq \
    netcat-openbsd \
    python3 \
    python3-pip \
    rclone \
    && rm -rf /var/lib/apt/lists/*

# Create a normal user so ~/.local/bin and systemd --user paths are realistic.
# Pre-create the test-data directory with correct ownership so the Docker volume
# inherits it instead of defaulting to root.
RUN useradd -m -s /bin/bash testuser \
  && mkdir -p /home/testuser/test-data \
  && chown -R testuser:testuser /home/testuser

# Test scripts and helpers
COPY --chown=testuser:testuser scripts/e2e-sandbox/client-test.sh /home/testuser/client-test.sh
COPY --chown=testuser:testuser scripts/e2e-sandbox/socket-send.py /home/testuser/socket-send.py
RUN chmod +x /home/testuser/client-test.sh /home/testuser/socket-send.py

# The install script is downloaded from GitHub in the test, but keep a copy
# available so we can also test the local version if needed.
COPY --chown=testuser:testuser packaging/install/install.sh /home/testuser/install.sh

USER testuser
WORKDIR /home/testuser

ENV PATH="/home/testuser/.local/bin:${PATH}"
ENV LAMASYNC_SOCKET_PATH=/home/testuser/lamasync.sock

ENTRYPOINT ["/home/testuser/client-test.sh"]
