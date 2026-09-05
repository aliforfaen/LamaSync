# LAMA-301 — Manual production server deploy control

## Outcome

Add an Admin-page control that requests a deployment of the configured
LamaSync server environment and shows durable, bounded status/output. In the
current production topology this means running the fixed LXC script
`/home/messhias/lamasync/update.sh`, which pulls the current GHCR `:latest`
image (or builds locally on pull failure) and recreates `lamasync-server`.

Call the UI **Deploy latest server image**, not “Update server”: production
tracks master/GHCR `:latest`, while GitHub release version metadata can be
unchanged across normal master pushes.

## Hard security boundary

The server runs inside the Docker container being updated. It must never be
given `/var/run/docker.sock`, host SSH credentials, privileged mode, or a
generic shell-execution endpoint. A web API that executes user-provided
commands is explicitly out of scope.

Instead introduce a small, LXC-resident **deploy agent** under the production
operator's control. It executes exactly one allowlisted script and reports
status to the normal LamaSync API. The existing server container stays
unprivileged.

## Deploy-agent design

Install a minimal systemd service on the LXC (initially production-only):

```text
lamasync-deploy-agent
  → polls/claims server-deploy jobs using a dedicated deploy credential
  → runs /home/messhias/lamasync/update.sh with a fixed working directory
  → records sanitized, capped result
  → reports completion after the container returns healthy
```

The server owns a dedicated job model rather than pretending the Docker server
is an ordinary daemon host:

```ts
type ServerDeployStatus = "pending" | "running" | "succeeded" | "failed";

interface ServerDeployJob {
  id: string;
  requestedAt: number;
  requestedBy: string | null; // managed-key id/name when available; never a secret
  status: ServerDeployStatus;
  startedAt: number | null;
  completedAt: number | null;
  target: "production";
  summary: string | null;
  outputTail: string | null; // scrubbed, capped (e.g. 16 KiB)
}
```

Only one active (`pending`/`running`) production job may exist. Duplicate
button clicks return that job, not a second deployment. Retain a short history
for auditability; operation-log retention must not erase deploy audit rows.

The agent credential is a dedicated, narrowly-scoped principal—not the master
key and not a general device key. Add route-level authorization that permits it
only to claim/heartbeat/complete deployment jobs. Admin/master credentials can
request/read jobs; ordinary device keys cannot.

### Agent execution flow

1. Claim one pending production job atomically and write `running`.
2. Run only the compiled-in absolute script path with no user arguments,
   a controlled working directory, timeout (e.g. 10 minutes), and a scrubber
   that removes bearer tokens, `KEY=value` secrets, and environment dumps.
3. Capture stdout/stderr incrementally, cap it to the final 16 KiB, and write
   stage updates (`pulling`, `building`, `recreating`, `waiting for health`)
   before the server downtime.
4. After `update.sh` returns, wait for the API health endpoint with bounded
   exponential backoff. The SQLite volume survives container recreation, so
   the agent can complete the same job after the API is back.
5. Persist `succeeded` or `failed` with exit code and sanitized summary. A
   timeout/crash leaves a reclaimable stale-running job, analogous to existing
   daemon action recovery.

Do not automatically roll back on a failed deploy in v1. The existing
operator rollback procedure in `docs/prod-deploy.md` remains the recovery
path, linked directly from the failure state.

## Server/API surface

Add an admin-only route family, documented in Swagger and the agent skill:

```text
POST /api/v1/server-deploys                 request/reuse the active deployment
GET  /api/v1/server-deploys                 recent deployment history
GET  /api/v1/server-deploys/:id             status/output tail
GET  /api/v1/server-deploys/pending         deploy-agent claim (deploy principal)
POST /api/v1/server-deploys/:id/claim       deploy-agent atomic claim
POST /api/v1/server-deploys/:id/progress    deploy-agent stage/output update
POST /api/v1/server-deploys/:id/complete    deploy-agent completion
```

The exact claim path may be condensed, but preserve atomic claim semantics and
strict principal separation. Add DB columns in both `SERVER_SCHEMA` and
`MIGRATIONS`. Broadcast job changes over the existing WebSocket so the UI can
reconnect after the expected server restart; polling is the fallback.

The control is unavailable unless the server is explicitly configured for it,
for example `LAMASYNC_DEPLOY_AGENT_ENABLED=true`. An unconfigured deployment
must render “manual deploy only” with the documented SSH/update command—not a
button that creates jobs nobody can claim.

## Admin UX

Add a **Server deployment** card to Admin:

- current server version, latest known release (informational only), and last
  deployment result/time;
- **Deploy latest server image** only in enabled environments;
- an explicit confirmation explaining the API will briefly restart, the data
  volumes are preserved, and this deploys the configured production target;
- live stage/status plus a sanitized, collapsible output tail;
- retry only after a terminal state; when failed, link the operator to
  `docs/prod-deploy.md` rollback/health procedures.

No version/ref/command text fields belong in this UI.

## Packaging and operations

- Put the deploy agent and its systemd template under a dedicated packaging
  path, separate from the daemon client installer.
- Document provisioning, credential creation/rotation, service ownership,
  socket/network reachability, timeout, logs, and uninstall in
  `docs/prod-deploy.md`.
- Ensure the fixed script path/working directory and required Docker/compose
  permissions are validated at agent boot; report an unavailable agent clearly.
- Test with a disposable compose environment before production. Production
  deployment is an operator action and is not performed by CI/tests.

## Tests and acceptance

- DB migration, one-active-job invariant, admin/deploy-principal/device-key
  authorization matrix, stale job reclaim, and output scrubbing/cap tests.
- Agent unit tests with injected process and health probes: success, no-change,
  pull/build failure, restart downtime, health timeout, and agent crash/reclaim.
- Web UI tests for disabled/configured/pending/running/succeeded/failed states;
  verify confirmation and duplicate-click coalescing.
- Docker disposable-environment smoke: request → agent claim → fixed-script
  execution → server health returns → persisted successful job.
- Required gates: `bun x tsc --noEmit`, `bun run build:web-ui`, `bun test`,
  and strict skill-drift.

## Non-goals

- No Docker socket or host credentials inside `lamasync-server`.
- No arbitrary shell/API command execution, compose-file editor, image/ref
  picker, fleet-wide rollout, or automatic rollback.
- No promise that a GitHub release version equals the current GHCR `:latest`
  image; image deployment state is its own fact.
