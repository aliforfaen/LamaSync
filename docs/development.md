# Development guide — LamaSync

Detailed development instructions. The lean essentials live in `AGENTS.md`;
this file is the full reference.

## Prerequisites

- **Bun** ≥ 1.3 (required: `bun:sqlite`, `bun build --compile`)
- **rclone** (not needed in unit tests, but checked at Docker runtime)
- **TypeScript** 5.x (installed as devDependency)

## Quick start

```bash
# Install dependencies (one-time)
bun install

# Type check (always green before committing)
bun x tsc --noEmit

# Run tests (web UI dist must exist first; see build:web-ui below)
bun test

# Build all distributable binaries
bun run build
# → packages/server/dist/lamasync-server
# → packages/daemon/dist/lamasyncd
# → packages/cli/dist/lamasync (+ dist/lamasync-tui compat copy)

# Or, just build the web UI so server tests pass:
# bun run build:web-ui

# Start the server for local dev
LAMASYNC_API_KEY=dev-key \
LAMASYNC_DATA_DIR=/tmp/lamasync-test \
LAMASYNC_BACKUP_DIR=/tmp/lamasync-test-backups \
  bun run dev:server

# Run the daemon (needs a running server + ~/.config/lamasync/client.toml)
bun run dev:daemon

# Run the CLI against a local server
LAMASYNC_SERVER_URL=http://localhost:8080 LAMASYNC_API_KEY=dev-key \
  bun run dev:cli status
```

## Environment variables

| Variable | Used by | Default |
|----------|---------|---------|
| `LAMASYNC_API_KEY` | server, CLI, daemon | — (required for server) |
| `LAMASYNC_DATA_DIR` | server, daemon cache, shares.json | `/data` |
| `LAMASYNC_BACKUP_DIR` | server, config generator | `/backups` |
| `LAMASYNC_LOG_RETENTION_DAYS` | server | `90` |
| `LAMASYNC_TAILNET_IP` | server config generator | `null` |
| `LAMASYNC_SHARES` | server shares route | `null` (falls back to `shares.json`) |
| `PORT` | server | `8080` |
| `LAMASYNC_SERVER_URL` | CLI | `http://localhost:8080` (env fallback) |
| `LAMASYNC_ORIGIN` | server (mobile flow) | unset — mobile enrollment exchange/bootstrap return 503 until set to a canonical `https://` origin |
| `LAMASYNC_MOBILE_LANDING_DIR` | server (LAMA-296 stage 1) | `<LAMASYNC_BACKUP_DIR>/Mobile` — server-local root for verified uploads (inside the browse root) |
| `LAMASYNC_MOBILE_STAGING_DIR` | server (LAMA-296 stage 1) | `<tmp>/lamasync-mobile-staging` — upload staging OUTSIDE the browse tree |
| `LAMASYNC_MOBILE_CHUNK_BYTES` | server (LAMA-296 stage 1) | `4194304` — negotiated max bytes per chunk request |
| `LAMASYNC_MOBILE_MAX_UPLOAD_BYTES` | server (LAMA-296 stage 1) | `2147483648` (2 GiB) — per-upload cap |
| `LAMASYNC_MOBILE_STAGING_QUOTA_BYTES` | server (LAMA-296 stage 1) | `8589934592` (8 GiB) — rough total staging bound |
| `LAMASYNC_MOBILE_ABANDON_TTL_MS` / `LAMASYNC_MOBILE_SWEEP_MS` | server (LAMA-296 stage 1) | `7d` / `24h` — abandoned-staging reconcile TTL / sweep interval (`0` disables the timer) |
| `LAMASYNC_SOCKET_PATH` | daemon, CLI local mode | `$XDG_RUNTIME_DIR/lamasync.sock` (falls back to `~/.lamasync/lamasync.sock` when XDG is unset) |

## Writing tests

Tests use `bun:test` (`describe`, `test`, `expect`). Place them alongside the source files as `*.test.ts`. Run with `bun test` from the repo root.

For a quick end-to-end smoke that starts a real server + daemon and exercises the CLI and web UI routes, run:

```bash
./scripts/e2e-harness.sh
```

For isolated Docker tests of the `curl | bash` install and update paths:

```bash
./scripts/test-install.sh
./scripts/test-update.sh
```

For a full client end-to-end sandbox (install, registration, normal backup,
dotfile backup, operation-log verification) in Docker Compose:

```bash
cd scripts/e2e-sandbox && docker compose up --build --abort-on-container-exit
```

The complete client end-to-end path (Proxmox-over-tailnet, install → register
→ backup → dotfile → log verification) is the `scripts/e2e-sandbox/`
Docker Compose sandbox. The Command Center v1 (LAMA-183) browser dogfood
matrix is preserved in git history if you need to re-run it.

Current coverage: every `*.test.ts` in the source tree (101 files; 1,138
passing and 9 skipped on 2026-08-30). Worth knowing by name:
- `packages/core/src/test.test.ts` — DB schema, config parsing, version constant
- `packages/server/src/routes/config.test.ts` — rclone config generation, encryption, peer detection
- `packages/server/src/routes/{shares,operations,restic,conflicts,backends,browse,stats,actions,hosts}.test.ts` — REST routes
- `packages/daemon/src/{socket,systemd,self-update,lock,config,executor,scheduler,hooks,lan-peer,update-check,actions,report-queue}.test.ts` — daemon behaviour
- `packages/cli/src/cli/{args,output,client,commands,dispatch}.test.ts` — CLI dispatch + helpers

## Adding a new API endpoint

1. Add the type (if needed) to `packages/core/src/types.ts`
2. Add the client method to `packages/core/src/api-client.ts`
3. Add the endpoint to `packages/core/src/db/schema.ts` (if it needs persistence) and the migrations array
4. Create a route file in `packages/server/src/routes/` exporting an Elysia plugin with a `detail` block (Swagger tags)
5. Import and `.use()` the plugin in `packages/server/src/index.ts`
6. Add the endpoint to `packages/agent-skill/reference/api.md` (drift-checked by `scripts/check-skill-drift.ts` in CI)
7. Run `bun x tsc --noEmit` and `curl`-test the endpoint

## Adding a new CLI subcommand

1. Create `packages/cli/src/cli/<command>.ts` implementing `CliCommand`
   (run + help; see `dispatch.ts` for the type and `folders.ts` for a
   representative module).
2. Register it in the dispatch tree in `packages/cli/src/cli/dispatch.ts`.
3. Add unit tests next to the command module.
4. Document the command in `packages/agent-skill/reference/cli.md`
   (strict drift check runs in CI).

## Android companion (LAMA-296 phase 1 → stage 2)

The Android app is a **standalone Gradle project** (`android/`) that is
deliberately outside the Bun workspace: `bun` never discovers it, and its
build needs neither the Bun toolchain nor the repo's `node_modules`.

Toolchain (recorded in `android/gradle/libs.versions.toml`; stage 1 adds
WorkManager 2.10.0 — the compileSdk-35-compatible stable release per the
official data-transfer guidance):

| Component | Version |
|-----------|---------|
| JDK | 17 (`JAVA_HOME=/usr/lib/jvm/java-17-openjdk` on the dev box) |
| Android SDK | `/opt/android-sdk` (`ANDROID_HOME`), platform android-35 |
| Gradle | 8.11.1 (wrapper `./android/gradlew`) |
| Android Gradle Plugin | 8.9.3 |
| Kotlin | 2.2.21 (android + compose + serialization plugins) |
| compileSdk / targetSdk / minSdk | 35 / 35 / 26 |
| Jetpack Compose BOM | 2025.07.00 (material3), CameraX 1.4.2, ML Kit barcode 17.3.0, WorkManager 2.10.0 |

The SDK is pinned to compileSdk 35 on purpose: SDK 36 components require a
provisioning step this project does not perform, and the whole chosen matrix
runs against the platforms already installed — `gradlew` provisions **no**
new SDK components. `applicationId` is `app.lamasync.companion` (stable once
chosen) with `versionName 0.1.0`.

Build, lint, and unit tests (148 JVM tests; instrumented tests need a
device/AVD):

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
export ANDROID_HOME=/opt/android-sdk

./android/gradlew -p android assembleDebug          # → android/app/build/outputs/apk/debug/app-debug.apk
./android/gradlew -p android lintDebug              # 0 errors expected (warnings are version-available notices)
./android/gradlew -p android testDebugUnitTest      # 148 unit tests, no device required
./android/gradlew -p android connectedDebugAndroidTest  # 52 tests (2 permission-negative tests skip w/o the extra pass)
```

### Stage-2 automatic protection (permissions, scheduling, tests)

- **Media permissions** (official guidance, API tiers): `READ_EXTERNAL_STORAGE`
  (maxSdk 32), `READ_MEDIA_IMAGES` + `READ_MEDIA_VIDEO` (33+), and
  `READ_MEDIA_VISUAL_USER_SELECTED` (34+) requested in ONE dialog so the app
  can distinguish FULL / PARTIAL (selected photos only) / NOT_GRANTED access.
  Scope is checked LIVE (per scan / on resume) — never stored as authority.
- **Discovery** scans per-volume MediaStore collections with keyset
  pagination `(date_added, _id)`. `LIMIT` is passed through the query-args
  bundle (`QUERY_ARG_SQL_SORT_ORDER` + `QUERY_ARG_LIMIT`): API 35 rejects
  `LIMIT` embedded in the sortOrder string. New-only boundaries are captured
  BEFORE the first import query (race-safe); edits of known rows are caught
  by a known-ids reconciliation (size/date_modified); partial access never
  claims deletions (rows outside the selected set become UNREADABLE).
- **Scheduling**: a unique prompt `:auto-protect-discovery` one-time worker
  (local-only constraints — discovery needs no network) + a ~6 h unique
  periodic `:auto-protect-reconcile`. Automatic items drain via the
  DEDICATED `lamasync:auto-upload-queue` work constrained by the AUTOMATIC
  policy in `AutoProtectSettings`; manual/user uploads keep the stage-1
  `UPLOAD_QUEUE_WORK_NAME` drainer with the stage-1 `UploadPolicyStore` —
  neither policy can delay the other kind (the worker filters by item kind).
  Boot recovery re-enqueues both. Long transfers promote to a `dataSync`
  foreground-service worker on every supported API level — notification
  permission is NOT a precondition (the FGS notification surfaces in the
  Task Manager even when `POST_NOTIFICATIONS` is denied); only a genuine OS
  refusal (background FGS start restriction) degrades the pass to a plain
  constrained worker (durable per-chunk offsets keep progress, and the
  degradation is reported via worker progress).
- **Instrumented coverage** runs on the API-35 `lamadb-test` AVD: real
  MediaStore inserts (camera photo, screenshot, >64 MiB video), idempotent
  duplicate scans, local-deletion detection, WorkManager constraint REPLACE
  (network + charging), plus the stage-2 HTTPS vertical (see below).
- **Permission-negative pass** (documented optional): revoking a runtime
  permission of a RUNNING app force-stops it, so the two negative tests are
  shell-prepared OUTSIDE the process:

```bash
# fresh install, then per state:
adb shell pm revoke app.lamasync.companion android.permission.READ_MEDIA_IMAGES
adb shell pm revoke app.lamasync.companion android.permission.READ_MEDIA_VIDEO
adb shell am instrument -w -r \
  -e class app.lamasync.companion.media.MediaStoreDiscoveryInstrumentedTest#revokedMediaAccessIsDetectedAsNotGranted \
  -e mediaScopeNegative true \
  app.lamasync.companion.test/androidx.test.runner.AndroidJUnitRunner
# partial: revoke images/video, GRANT READ_MEDIA_VISUAL_USER_SELECTED only, then run
#   ...#partialSelectedAccessIsDetectedAsPartialNotFull with the same -e mediaScopeNegative true
```

With a live server configured, the suite also runs the stage-1 vertical
(uploads) and the stage-2 auto-protect vertical. A **fresh server data dir is
required per full vertical run** — the suite seeds the same display names
across runs and asserts uniqueness (see the `rm -rf $V/data/*` step below).

### Stage-1 HTTPS vertical (manual uploads, disposable server)

The phase-1 vertical pattern extends to uploads: a disposable server from
source behind an socat TLS front door with `LAMASYNC_ORIGIN=https://10.0.2.2:<port>`
and a self-signed CA (SAN `IP:10.0.2.2`) installed in the AVD user store
(`adb push` to `/data/misc/user/0/cacerts-added/<subject-hash-old>.0`, reboot;
debug builds trust user CAs). The repo-local helper used for this milestone:

```bash
# /tmp/lamasync-vertical/run-vertical.sh — wipes disposable data, (re)starts
# the server + socat front door, installs the APK, runs the connected suite
# with verticalOrigin/verticalAdminKey instrumentation args.
/tmp/lamasync-vertical/run-vertical.sh
```

It runs the phase-1 enrollment verticals plus `VerticalUploadFlowTest` (a
65 MiB+ chunked upload through the real HTTPS stack with ≤ 1 MiB payloads
and server-side verification, and a declared-checksum-mismatch negative)
and `VerticalAutoProtectTest` (stage 2: REAL MediaStore rows — a camera
photo and a >64 MiB video — through real discovery → bounded staging →
idempotent enqueue → resumable transfer; checksum-verified arrival in the
Data Browser, `operation_log` provenance with the real mobile host id,
no duplicates on repeat scans, and a local deletion leaving the server
copy intact).

The stage-1 correction pass rebuilt this disposable harness from scratch
(it is host-local by design and was absent):

```bash
# 1. TLS material
export V=/tmp/lamasync-vertical
mkdir -p $V/certs $V/data $V/backups && cd $V/certs
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 365 -nodes \
  -subj "/CN=LamaSync Vertical CA"
openssl req -newkey rsa:2048 -keyout leaf.key -out leaf.csr -nodes -subj "/CN=10.0.2.2"
printf 'subjectAltName=IP:10.0.2.2,DNS:localhost\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out leaf.crt -days 365 -extfile leaf.ext
# 2. Install the CA into the AVD user store, then reboot the emulator
HASH=$(openssl x509 -in ca.crt -subject_hash_old -noout)
adb root && adb push ca.crt /data/misc/user/0/cacerts-added/$HASH.0 \
  && adb shell chmod 644 /data/misc/user/0/cacerts-added/$HASH.0 && adb reboot
# 3. Fresh server behind the TLS front door
rm -rf $V/data/*
env LAMASYNC_DATA_DIR=$V/data LAMASYNC_BACKUP_DIR=$V/backups \
  LAMASYNC_API_KEY=lamasync-vertical-master-key-1234567890 \
  LAMASYNC_SECRET_KEY=lamasync-vertical-secret-key-9876543210 \
  LAMASYNC_ORIGIN=https://10.0.2.2:8444 PORT=8081 \
  bun run packages/server/src/index.ts &
socat OPENSSL-LISTEN:8444,reuseaddr,fork,cert=$V/certs/leaf.crt,key=$V/certs/leaf.key,verify=0 \
  TCP:127.0.0.1:8081 &
# 4. Run the whole instrumented suite with the vertical args
cd /path/to/repo
JAVA_HOME=/usr/lib/jvm/java-17-openjdk ANDROID_HOME=/opt/android-sdk \
./android/gradlew -p android connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.verticalOrigin=https://10.0.2.2:8444 \
  -Pandroid.testInstrumentationRunnerArguments.verticalAdminKey=lamasync-vertical-master-key-1234567890
```

### HTTPS prerequisite for the Android flow

The QR flow is an **HTTPS-only** contract:

- The server must run with `LAMASYNC_ORIGIN` set to the canonical
  `https://` origin clients reach (`https://fleet.example.com`, never a
  tailnet IP over plain HTTP). Without it, mobile enrollment
  create/exchange and the web-session bootstrap return 503.
- The app only accepts `https://` origins with normal certificate
  validation; the QR's `serverOrigin` is that same canonical origin.
- Existing HTTP tailnet installations keep working for the existing desktop
  clients — they simply cannot enroll an Android device until an HTTPS front
  door exists.

Local TLS development: run the server behind any HTTPS reverse proxy whose
certificate the device trusts. Debug builds additionally trust
user-installed CA certificates (`android/app/src/debug/res/xml/network_security_config.xml`;
no cleartext is ever permitted). Install your local CA on the device/AVD
(`adb push` + Settings → Security → Install a user certificate, or
`emulator`'s `-writable-system` CA path) so debug builds accept it. Release
builds never reference that file and use normal platform validation.

## Docker

Build and run:

```bash
cp docker/.env.example docker/.env
# edit docker/.env to set LAMASYNC_API_KEY

docker compose -f docker/docker-compose.yml up -d
# Server is now at http://127.0.0.1:8080 (or your tailnet IP)
```

The image includes `rclone` and `tini`. Volumes are named (`lamasync-data`, `lamasync-backups`). The healthcheck pings `/api/v1/health` with the API key.

## Version and release

- **Version source of truth**: root `package.json` `version` field (currently `0.3.4`).
- **Generated constant**: `scripts/gen-version.ts` writes `packages/core/src/version.ts`, which is re-exported from `@lamasync/core`.
- **All three standalone binaries** support `--version` and `-V`:
  `lamasync-server`, `lamasyncd`, `lamasync`. The web UI is bundled
  inside `lamasync-server` (built with `--loader .html:text`) and served
  from `GET /`; it has no separate version flag.
- **GitHub Actions**: `.github/workflows/ci.yml` runs type-checks, tests, builds the three binaries, publishes them to a GitHub Release on `v*` tags, and pushes a Docker image to GHCR.
- **Self-update**: daemon checks GitHub Releases on startup and supports `lamasyncd --check-update` / `lamasyncd --update`. The server proxies release info at `GET /api/v1/release/latest`. A standalone `curl | bash` updater lives in `packaging/install/update.sh`.
