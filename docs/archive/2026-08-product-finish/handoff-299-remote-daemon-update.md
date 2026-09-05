# LAMA-299 — Remote daemon update from Host Detail

## Outcome

Let an administrator update an online LamaSync client from its **Host detail**
page. The web control queues a trusted request; the daemon performs the same
release-proxy download-and-atomic-replace flow as `lamasyncd --update`, then
restarts its user service and reports a durable result through the existing
action history.

This is a fleet-control feature, not remote shell access. The server never
accepts an argv string, script URL, asset URL, or target path from the web UI.

## Existing seams to reuse

- The web UI already displays `host.updateAvailable` and has Host-detail action
  buttons plus pending/taken/done/failed action history.
- `queued_actions` is the authenticated server → daemon transport. Admin keys
  enqueue; a device key only claims/acks its own work.
- `packages/daemon/src/self-update.ts` already owns release metadata, asset
  selection, atomic binary replacement, and safe compiled-binary path
  resolution.
- The daemon obtains release data through `GET /api/v1/release/latest`, which
  is cached by the server to avoid GitHub rate-limit fan-out.

## Contract

Add a queued action type:

```ts
"update_daemon"
```

It has no caller-provided payload. The daemon always targets the latest signed
GitHub release returned by LamaSync's release proxy and chooses only its own
supported daemon asset. It must not allow `LAMASYNC_UPDATE_ASSET` or any UI
field to select an arbitrary asset for a remotely initiated update.

The action is admin-only, like every existing control-plane action. Device
credentials may claim/complete it only for their bound host. The API and skill
docs must document the new action before it ships.

### Capability and bootstrap rule

An older daemon does not understand `update_daemon`; it will mark it as an
unknown action. Therefore this v1 button is enabled only for a host whose
reported daemon version is at or above the release that adds this action.
Older/offline/unversioned hosts show a clear manual-upgrade instruction,
rather than receiving a job that cannot succeed. The existing manual
`lamasyncd --update` / installer path remains the bootstrap route.

Choose and document a single `REMOTE_DAEMON_UPDATE_MIN_VERSION` constant shared
by server/UI tests. Do not infer support merely from `updateAvailable`.

## Daemon flow

Refactor the current `--update` body into a reusable, injected helper that
returns a structured outcome, for example:

```ts
type DaemonUpdateOutcome =
  | { ok: true; changed: false; currentVersion: string; latestVersion: string }
  | { ok: true; changed: true; currentVersion: string; latestVersion: string; asset: string }
  | { ok: false; phase: "preflight" | "release" | "asset" | "replace" | "restart"; summary: string };
```

Before replacement, verify only facts needed to execute safely:

- the daemon has a valid resolved server URL and a non-empty credential;
- `GET /auth/me` and the release proxy are reachable with that credential;
- latest release metadata is well formed and contains a daemon asset compatible
  with the current host;
- the installed binary path is an allowed compiled-binary path and is writable.

Never include the API key, authorization header, raw config file, or full URL
query values in an action result or operation log. User-facing results name the
phase and version only.

If latest is not newer, acknowledge `done` with “already at vX”. Otherwise:

1. Atomically download and replace the daemon binary using the shared helper.
2. Persist/ack the action **before** requesting restart: “installed vX; service
   restart requested”. This prevents an in-flight action being orphaned when
   the current process exits.
3. Restart the known `lamasyncd.service` user unit through the existing
   systemd abstraction. Do not shell out via an interpolated service name.
4. On the next heartbeat, server/UI compare reported host version to the
   requested version and render “updated / awaiting heartbeat / mismatch”.

If systemd is unavailable, return a failed action with a precise manual
restart command; do not leave a replaced binary silently running old code.
Skill-bundle refresh is intentionally out of scope: it remains the explicit
`lamasyncd --update skill` workflow so binary/skill versions cannot drift
silently.

## Web UX

On Host Detail, replace the generic “Check update” prominence with a small
**Software** section:

- installed version and latest release;
- update availability / capability / online state;
- primary **Update daemon** button only when eligible;
- a confirmation dialog stating current → target version, service restart, and
  that local sync work is not cancelled by the UI;
- disabled explanatory states for offline, no version, old daemon, no update,
  or an already-pending update action;
- action timeline with queued, claimed, replaced/restarting, done, or failed
  summary. Poll the existing action history at a modest cadence while pending;
  use WebSocket events where available.

Keep **Check update** as a diagnostic action, not a prerequisite button.

## Tests and acceptance

- Core/action type and action-route schema permit `update_daemon`; device
  authorization boundaries remain unchanged.
- Pure daemon update helper: no-update, bad config, auth/proxy failure,
  incompatible/missing asset, replace failure, and success outcomes. Assert no
  secret leaks in every error/result.
- Action dispatcher acks before invoking restart; restart failure is visible.
- UI tests cover each capability state and prevent duplicate pending requests.
- Regression: old daemon action is never offered as remotely updatable.
- Manual disposable-host smoke: queue update, observe action completion,
  systemd restart, a fresh heartbeat with new version, then a normal sync.

Run `bun x tsc --noEmit`, `bun run build:web-ui`, `bun test`, and
`bun scripts/check-skill-drift.ts --strict`.

## Non-goals

- No arbitrary remote command execution.
- No remote downgrade, channel picker, or custom release URL.
- No automatic fleet-wide rollout; this is one host at a time.
- No update of pre-capability daemons through this API.
