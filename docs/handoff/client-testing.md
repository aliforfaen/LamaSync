# LamaSync Client Testing Handoff

Goal: safely exercise the full client install, registration, and backup path in a repeatable, isolated sandbox before touching production data.

Last updated: 2026-07-21

---

## Sandbox options

| Approach | Best for | Pros | Cons |
|---|---|---|---|
| **Docker Compose** (`scripts/e2e-sandbox/`) | Quick smoke tests, install/registration/dotfiles, CI gates | Fast, isolated, reproducible, easy reset | Full rclone backup over SFTP is not exercised; normal backup only verifies operation logs |
| **Proxmox LXC / VM client** | Realistic end-to-end backup over tailnet | Matches production topology, tests real SFTP/S3 backend | Slower, needs tailnet, more moving parts |
| **Production LXC + throwaway client** | Final validation against the real server | Verifies the exact server config and network | Risk of touching real data if not scoped carefully |

Recommended workflow:
1. **Docker Compose** first for every change.
2. **Proxmox LXC** second for real backup IO verification.
3. **Production smoke** only after 1+2 pass, using a dedicated test folder and host.

---

## Approach A: Docker Compose sandbox

Files:
- `scripts/e2e-sandbox/docker-compose.yml`
- `scripts/e2e-sandbox/client.Dockerfile`
- `scripts/e2e-sandbox/client-test.sh`
- `scripts/e2e-sandbox/socket-send.py`

### What it tests
- `curl | bash` install from the published GitHub release
- `lamasyncd` starts and registers itself with the server
- Normal backup operation is accepted, scheduled, and reports `success`
- Dotfile manifest creation and dotfile tarball upload via API
- Operation logs are written and queryable on the server
- Client daemon log is readable

### What it does NOT test
- Real rclone SFTP transfer to a remote server (Docker server is local, no SSH server)
- Encryption-at-rest paths requiring rclone crypt
- LAN peer sync
- Bandwidth / disk-space pre-flight against real volumes

### Quick start

```bash
cd scripts/e2e-sandbox

# Optional: pin a release tag if you do not want latest
export LAMASYNC_SERVER_TAG=v0.2.1
export LAMASYNC_API_KEY=sandbox-api-key

# Pull/build and run the full test
docker compose up --build --abort-on-container-exit

# Watch server logs in another terminal
docker logs -f lamasync-server-sandbox
```

The `client` container exits with code `0` on success and `1` on failure. The server container keeps running until you stop it.

### Test flow (client-test.sh)

1. **Install**: runs `packaging/install/install.sh` from the copied file with `--server-url`, `--api-key`, `--hostname sandbox-client`, `--with-tui`.
2. **Configure**: writes `~/.config/lamasync/client.toml`.
3. **Start daemon**: runs `lamasyncd` in the background, logs to `~/lamasyncd.log`.
4. **Register**: polls `/api/v1/hosts` until `sandbox-client` appears.
5. **Normal backup**: creates `~/test-data` with photos, docs, nested dirs, and a file with special characters; creates a `backup` folder on the server and assigns it; triggers `sync-all`; waits for the operation log to report `success`.
6. **Dotfile backup**: creates `~/.config/testapp/` files; creates a `dotfile` folder on the server and a matching manifest; triggers `sync-all`; verifies the manifest and tarball versions exist on the server.
7. **Logs**: prints the tail of the client daemon log and the server operation log for the test host.

### IO verification inside the sandbox

After the test runs, inspect the server backup volume:

```bash
# Server backup volume location on the Docker host
docker volume inspect e2e-sandbox_server-backups

# Or inspect from inside the server container
docker exec -it lamasync-server-sandbox bash
ls -la /backups/dotfiles/
```

Dotfile tarballs should appear under `/backups/dotfiles/sandbox-dotfiles/`.

### Log locations

| Component | Location | Command |
|---|---|---|
| Server container | Docker logs | `docker logs -f lamasync-server-sandbox` |
| Server DB /data | Named volume | `docker exec -it lamasync-server-sandbox bash` then `ls /data` |
| Client daemon | Inside client container | `docker compose logs client` or the printed tail |
| Client raw log | Inside client container | `/home/testuser/lamasyncd.log` |

### Cleanup

```bash
cd scripts/e2e-sandbox
docker compose down -v   # removes containers and named volumes
```

### Troubleshooting

- **Client cannot reach server**: check `LAMASYNC_SERVER_URL` in `docker-compose.yml`. Inside the Docker network the server hostname is `server`.
- **Install script fails**: check that the GitHub release exists and the client has outbound internet. Use the copied `install.sh` inside the image to test local changes.
- **Daemon never registers**: check `~/lamasyncd.log` for the client; verify the server is healthy with `curl -fsSL http://localhost:8080/api/v1/health`.
- **Backup operation fails**: query the server operation log for details; the local backend fallback may write files to the client container, not the server, so only the operation log is validated in this sandbox.

---

## Approach B: Realistic Proxmox client over tailnet

Use this when you want to verify that files actually land on the server safely via rclone SFTP.

### Setup

1. Create an LXC or VM on Proxmox (Ubuntu 24.04 recommended).
2. Join it to your Tailnet (or ensure it can reach the LamaSync server at `100.113.52.108:8080`).
3. Run the installer:

```bash
curl -sSL https://raw.githubusercontent.com/aliforfaen/LamaSync/master/packaging/install/install.sh | bash -s -- \
  --server-url http://100.113.52.108:8080 \
  --api-key "${LAMASYNC_API_KEY}" \
  --hostname "test-client" \
  --with-tui
```

4. Verify systemd started the daemon:

```bash
systemctl --user status lamasyncd
```

### Test checklist

- [ ] Host appears in the web UI / TUI / API within 30 seconds
- [ ] Create a test folder (e.g. `test-client-photos`) and assign it to `test-client`
- [ ] Create source files on the client with variety:
  - small text files
  - binary-ish files (use `dd if=/dev/urandom`)
  - nested directories
  - filenames with spaces and special characters
  - a file > 100 MiB to test chunking/timeout behavior
- [ ] Trigger sync and wait for `success`
- [ ] On the server, verify the files exist under `/backups/<folder-name>/`
- [ ] Modify a file on the client, re-sync, and verify the version changed
- [ ] Delete a file on the client, re-sync, and verify the server-side copy is removed (or retained, depending on folder type)
- [ ] Create a dotfile manifest for `test-client` and verify the tarball appears under `/backups/dotfiles/<app-name>/`

### Log locations

| Component | Command |
|---|---|
| Server (LXC) | `docker logs lamasync` if containerized, or `journalctl -u lamasync` if systemd |
| Server data | `/data` and `/backups` inside the server container |
| Client daemon | `journalctl --user -u lamasyncd -f` |
| Client raw log | `~/.local/share/lamasync/operations.json` (if exists) or stdout from `lamasyncd` |
| Client socket | `~/lamasync.sock` (or `$LAMASYNC_SOCKET_PATH`) |

### What to watch for in logs

- `registerHost` / `report/health` failures
- `lock` contention or `lock lost` messages
- `insufficient disk space` warnings
- rclone stderr containing `couldn't connect`, `permission denied`, `no such file`
- `dotfile upload failed` or `tar failed`
- High retry counts on a single folder

---

## Approach C: Production smoke with a throwaway client

Only after Docker and Proxmox tests pass.

1. Create a test folder on the production server with a unique name (`prod-smoke-<date>`).
2. Assign it only to the throwaway client hostname.
3. On the throwaway client, install and run the daemon.
4. Verify the backup lands under `/backups/prod-smoke-<date>/` on the server LXC.
5. Delete the test folder and the host from the server after the test.
6. Remove the test client volume or uninstall `lamasyncd`.

**Never use a production folder name for a test.** The current production data lives on the LXC at `100.113.52.108`.

---

## Additional things to add to the handoff / testing

Consider these for a more complete validation matrix:

1. **Conflict resolution**: create the same file on client and server, then sync. Verify the chosen strategy (`newer_wins`, `source_wins`, `keep_both`).
2. **Encryption**: create an encrypted folder, back up, and verify the server-side files are obfuscated by rclone crypt.
3. **Large file / bandwidth**: add a 1 GiB file and a `--bwlimit` schedule; verify the transfer respects the limit.
4. **Disk-space pre-flight**: fill the client disk near the threshold and confirm the operation fails cleanly with `insufficient disk space`.
5. **Restore path**: download a dotfile tarball and extract it; verify the restore matches the original files.
6. **Self-update**: run `lamasyncd --check-update` and `lamasyncd --update` in the sandbox.
7. **TUI smoke**: run `lamasync-tui` in `LAMASYNC_NO_TUI=1` CLI mode and navigate the local view.
8. **Scheduler edge cases**: `@reboot`, `@login`, and cron expressions.
9. **Failure injection**: kill the server mid-sync and verify the client reports failure, retries, and eventually succeeds.
10. **Metrics/observability**: export operation logs or Prometheus metrics if added later.

---

## Files and commands reference

```bash
# Run the Docker sandbox
cd scripts/e2e-sandbox
docker compose up --build --abort-on-container-exit

# Clean up the Docker sandbox
docker compose down -v

# Query server health
curl -fsSL http://localhost:8080/api/v1/health

# Query hosts
curl -fsSL -H "Authorization: Bearer ${API_KEY}" http://localhost:8080/api/v1/hosts

# Query operations for a host
curl -fsSL -H "Authorization: Bearer ${API_KEY}" \
  "http://localhost:8080/api/v1/operations?hostId=${HOST_ID}"

# Trigger sync from client socket (when daemon is running)
echo '{"cmd":"sync-all"}' | nc -U ~/lamasync.sock
# Or use the helper:
python3 scripts/e2e-sandbox/socket-send.py --socket ~/lamasync.sock --cmd sync-all
```
