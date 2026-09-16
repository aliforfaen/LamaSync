// LAMA-299: reusable daemon update flow.
//
// Both `lamasyncd --update` (operator-initiated) and the `update_daemon`
// queued action (admin-initiated, LAMA-299) run through the injected
// `performDaemonUpdate` helper so preflight checks, asset selection,
// atomic replacement, and secret hygiene stay in one testable place.
//
// Security contract (fleet-control feature, NOT remote execution):
//   - remotely initiated updates never accept a caller-provided payload,
//     argv string, script URL, asset URL, or target path;
//   - `LAMASYNC_UPDATE_ASSET` may select an asset only for the explicit
//     `--update` CLI path — it is never honored for remote updates;
//   - outcomes name the phase and version only. API keys, authorization
//     headers, config file contents, and URL query values never appear in
//     a result or log line (see `scrubForOutcome`).

import { accessSync, constants as fsConstants } from "fs";
import { dirname, isAbsolute } from "path";
import { VERSION } from "@lamasync/core";
import { isNewer, resolveSelfBinaryPath, type ReleaseInfo } from "./self-update.ts";
import type { DaemonUnitReconcileResult } from "./systemd.ts";

export type DaemonUpdatePhase =
  | "preflight"
  | "release"
  | "asset"
  | "replace"
  | "restart";

export type DaemonUpdateOutcome =
  | {
      ok: true;
      changed: false;
      currentVersion: string;
      latestVersion: string;
      unit?: DaemonUnitReconcileResult;
    }
  | {
      ok: true;
      changed: true;
      currentVersion: string;
      latestVersion: string;
      asset: string;
      unit?: DaemonUnitReconcileResult;
    }
  | {
      ok: false;
      phase: DaemonUpdatePhase;
      summary: string;
      unit?: DaemonUnitReconcileResult;
    };

/** Subset of the daemon config the preflight needs (no raw config file). */
export interface DaemonUpdateConfig {
  serverUrl: string;
  apiKey: string;
}

/** Injected dependencies — every effect is overridable for pure tests. */
export interface DaemonUpdateDeps {
  config: DaemonUpdateConfig;
  /** Server release proxy (client.getLatestRelease). */
  getLatestRelease: () => Promise<ReleaseInfo | null>;
  /** Prove the stored credential is accepted (GET /auth/me). */
  checkAuth?: () => Promise<boolean>;
  /** Restart-capability probe (default: systemd user manager present). */
  checkRestartAvailable?: () => boolean;
  /** Real on-disk binary path (default: resolveSelfBinaryPath). */
  resolveBinaryPath?: () => string;
  /** Writability probe for the resolved binary path. */
  checkWritable?: (path: string) => boolean;
  /** Atomic download + replace. */
  downloadAndReplace: (downloadUrl: string, binaryPath: string) => Promise<boolean>;
  /** Operator-controlled asset override — CLI `--update` only. */
  envAssetName?: string;
  /**
   * LAMA-311: reconcile an already-installed systemd user unit that predates
   * the current sandbox contract. Runs before *any* server interaction — before
   * the credential check, the release lookup, and the "already current"
   * short-circuit — so a stale unit is migrated even when the binary needs no
   * replacement and even when the control plane is unreachable. Injectable for
   * pure tests; a throw or a `failed`/`skipped` result never aborts the update
   * itself.
   */
  reconcileUnit?: () => DaemonUnitReconcileResult;
}

/**
 * Fixed daemon-asset selection for remotely initiated updates. Never
 * consults the environment; picks only the daemon's own assets — the
 * canonical `lamasyncd` binary or a `lamasyncd-*` per-platform variant.
 * Anything else (CLI compatibility assets, server, skill tarballs, `update.sh`)
 * is rejected.
 */
export function selectDaemonAsset(
  release: ReleaseInfo,
): ReleaseInfo["assets"][number] | null {
  return (
    release.assets.find((a) => a.name === "lamasyncd") ??
    release.assets.find((a) => a.name.startsWith("lamasyncd-")) ??
    null
  );
}

/**
 * CLI-only fallback matching the historical `--update` behavior (the
 * broad legacy `lamasync-` prefix). Never used for remote updates.
 */
export function selectDaemonAssetLegacy(
  release: ReleaseInfo,
): ReleaseInfo["assets"][number] | null {
  return (
    selectDaemonAsset(release) ??
    release.assets.find((a) => a.name.startsWith("lamasync-")) ??
    null
  );
}

/**
 * Scrub any embedded secrets out of a free-form message before it becomes
 * part of an action result or log line. Removes the daemon's own API key
 * and anything that looks like a bearer token or `KEY=value` secret.
 */
export function scrubForOutcome(message: string, apiKey?: string): string {
  let out = message;
  if (apiKey && apiKey.length > 0) {
    out = out.split(apiKey).join("[redacted]");
  }
  out = out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/\b(lmsk|sk|key|token|password|secret)[=_:-]\S+/gi, "$1=[redacted]");
  return out;
}

/** Default writability probe: W_OK on the file, else its parent directory. */
function defaultCheckWritable(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    try {
      accessSync(dirname(path), fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function fail(
  phase: DaemonUpdatePhase,
  summary: string,
  unit?: DaemonUnitReconcileResult,
): DaemonUpdateOutcome {
  return { ok: false, phase, summary, ...(unit ? { unit } : {}) };
}

/**
 * Attach the (optional) unit reconcile result to an outcome, without
 * inventing a placeholder when no reconciler was injected — `toEqual`-style
 * tests and callers can then distinguish "not attempted" from "skipped".
 */
function withUnit(
  outcome: DaemonUpdateOutcome,
  unit: DaemonUnitReconcileResult | undefined,
): DaemonUpdateOutcome {
  return unit ? { ...outcome, unit } : outcome;
}

/**
 * Run the full update flow with injected effects. Never throws — every
 * failure mode is a structured outcome so both callers (CLI and the
 * queued-action dispatcher) can surface a uniform, secret-free result.
 */
export async function performDaemonUpdate(
  deps: DaemonUpdateDeps,
): Promise<DaemonUpdateOutcome> {
  const { config } = deps;

  // ---- LAMA-311: migrate a stale systemd user unit - FIRST ----
  // The migration is purely local (read the unit, drop the obsolete sandbox
  // directives, daemon-reload) and is deliberately not gated on anything the
  // server provides — not on the stored credential, not on a reachable release
  // proxy, not even on a `client.toml` being present. That is what makes the
  // manual `lamasyncd --update` path a reliable remedy on a client where the
  // *effective* pre-fix sandbox stops the daemon from rewriting its own unit:
  // the operator's shell is not sandboxed, so the same call succeeds there even
  // with the control plane down and even when the binary needs no replacement.
  //
  // Also before the binary-path writability check, so a root-owned binary does
  // not block a user-owned unit migration. Never fatal to the update itself.
  let unit: DaemonUnitReconcileResult | undefined;
  if (deps.reconcileUnit) {
    try {
      unit = deps.reconcileUnit();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      unit = {
        status: "failed",
        summary: scrubForOutcome(`systemd unit reconcile threw: ${msg}`, config.apiKey),
        guidance: "systemctl --user daemon-reload && systemctl --user restart lamasyncd.service",
        restartRequired: false,
      };
    }
  }

  // ---- preflight: only facts needed to execute safely ----
  if (!config.serverUrl || config.serverUrl.length === 0) {
    return fail("preflight", "daemon config has no server URL", unit);
  }
  if (!config.apiKey || config.apiKey.length === 0) {
    return fail("preflight", "daemon config has no credential", unit);
  }

  if (deps.checkAuth) {
    let authOk = false;
    try {
      authOk = await deps.checkAuth();
    } catch (err) {
      authOk = false;
      void err;
    }
    if (!authOk) {
      return fail("preflight", "server rejected the daemon credential", unit);
    }
  }

  if (deps.checkRestartAvailable && !deps.checkRestartAvailable()) {
    return fail(
      "preflight",
      "systemd user manager unavailable; update manually with `lamasyncd --update` and restart lamasyncd.service",
      unit,
    );
  }

  const binaryPath = (deps.resolveBinaryPath ?? resolveSelfBinaryPath)();
  if (
    !binaryPath ||
    !isAbsolute(binaryPath) ||
    binaryPath.endsWith("/bun") ||
    binaryPath.endsWith("/node")
  ) {
    return fail(
      "preflight",
      "could not resolve a writable compiled daemon binary path",
      unit,
    );
  }
  const writable = deps.checkWritable ?? defaultCheckWritable;
  if (!writable(binaryPath)) {
    return fail("preflight", `binary path is not writable: ${binaryPath}`, unit);
  }

  // ---- release metadata via the server's cached release proxy ----
  let latest: ReleaseInfo | null = null;
  try {
    latest = await deps.getLatestRelease();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      "release",
      scrubForOutcome(`release proxy failed: ${msg}`, config.apiKey),
      unit,
    );
  }
  if (!latest) {
    return fail("release", "release proxy unreachable or malformed", unit);
  }

  // ---- asset selection (fixed; env override only for the CLI path) ----
  const envAsset =
    deps.envAssetName && deps.envAssetName.length > 0 ? deps.envAssetName : null;
  const asset = envAsset
    ? (latest.assets.find((a) => a.name === envAsset) ??
       // CLI miss falls back to the historical broad selection; the
       // remote path never reaches this branch.
       selectDaemonAssetLegacy(latest))
    : selectDaemonAsset(latest);
  if (!asset) {
    return fail(
      "asset",
      `no daemon asset in release ${latest.tag} (have: ${latest.assets.map((a) => a.name).join(", ") || "none"})`,
      unit,
    );
  }

  // ---- already current (the unit may still have been migrated above) ----
  if (!isNewer(VERSION, latest.version)) {
    return withUnit(
      {
        ok: true,
        changed: false,
        currentVersion: VERSION,
        latestVersion: latest.version,
      },
      unit,
    );
  }

  // ---- atomic replace ----
  let replaced = false;
  try {
    replaced = await deps.downloadAndReplace(asset.downloadUrl, binaryPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(
      "replace",
      scrubForOutcome(`binary replacement threw: ${msg}`, config.apiKey),
      unit,
    );
  }
  if (!replaced) {
    return fail(
      "replace",
      `failed to download/replace the daemon binary from ${latest.tag}`,
      unit,
    );
  }

  return withUnit(
    {
      ok: true,
      changed: true,
      currentVersion: VERSION,
      latestVersion: latest.version,
      asset: asset.name,
    },
    unit,
  );
}

/**
 * One-line, secret-free description of a unit reconcile for an ack result or
 * a CLI line. Returns `null` when there is nothing worth saying (the unit was
 * already current, or no reconciler ran).
 *
 * `autoRestart` is true when the caller is about to restart the service
 * itself, so the migrated case does not print a command the caller already ran.
 */
export function summarizeUnitReconcile(
  unit: DaemonUnitReconcileResult | undefined,
  opts: { autoRestart?: boolean } = {},
): string | null {
  if (!unit) return null;
  switch (unit.status) {
    case "current":
      return null;
    case "migrated":
      return opts.autoRestart === true
        ? "refreshed the systemd user unit"
        : "refreshed the systemd user unit; run `systemctl --user restart lamasyncd.service` to apply it";
    case "skipped":
      return `systemd unit unchanged: ${unit.summary}${unit.guidance ? ` — ${unit.guidance}` : ""}`;
    case "failed":
      return `systemd unit not refreshed: ${unit.summary}${unit.guidance ? ` — run: ${unit.guidance}` : ""}`;
  }
}

/** The single terminal ack a `update_daemon` action must write, plus whether a
 *  service restart has to follow it. */
export interface DaemonUpdateActionPlan {
  ackStatus: "done" | "failed";
  ackResult: string;
  /** Request `systemctl --user restart lamasyncd.service` after acking. */
  restart: boolean;
}

/**
 * Decide the `update_daemon` action's outcome from a completed update, as a
 * pure function so the ack/restart contract is testable.
 *
 * The contract (LAMA-311):
 *  - exactly ONE terminal ack per action. The server's completion endpoint is
 *    a blind UPDATE that also inserts an `operation_log` row, so the previous
 *    "ack done → restart → ack failed if the restart failed" sequence wrote
 *    two contradictory outcomes. Everything the restart could reveal
 *    (systemd availability, unit-reconcile state) is decided here, before the
 *    ack.
 *  - the restart is requested only AFTER the ack is durable, so systemd
 *    tearing the process down cannot leave the action orphaned in `taken`.
 *  - a migrated unit alone (binary already current) is still a change: it
 *    needs the same restart to take effect.
 *  - a unit that could not be reconciled makes the action `failed` even when
 *    the binary was replaced, with the operator's manual command in the
 *    result — the client is not in the intended state yet.
 */
export function planDaemonUpdateAction(
  outcome: DaemonUpdateOutcome,
  opts: { systemdAvailable: boolean },
): DaemonUpdateActionPlan {
  const unit = outcome.unit;
  const unitNote = summarizeUnitReconcile(unit, { autoRestart: true });
  if (!outcome.ok) {
    return {
      ackStatus: "failed",
      ackResult: `${outcome.phase}: ${outcome.summary}${unitNote ? ` (${unitNote})` : ""}`,
      restart: false,
    };
  }

  const unitMigrated = unit?.status === "migrated";
  const unitFailed = unit?.status === "failed";
  const restart = outcome.changed || unit?.restartRequired === true;

  const parts: string[] = [];
  if (outcome.changed) parts.push(`installed v${outcome.latestVersion}`);
  if (unitMigrated) parts.push("refreshed systemd unit");
  if (unitFailed && unit) parts.push(`systemd unit not refreshed (${unit.summary})`);

  if (!outcome.changed && !unitMigrated && !unitFailed) {
    return {
      ackStatus: "done",
      ackResult: `already at v${outcome.currentVersion}${unitNote ? ` (${unitNote})` : ""}`,
      restart: false,
    };
  }

  if (unitFailed) {
    return {
      ackStatus: "failed",
      ackResult: `${parts.join("; ")}${unit?.guidance ? `; run: ${unit.guidance}` : ""}`,
      // A successful binary replacement still needs its restart.
      restart,
    };
  }

  if (restart && !opts.systemdAvailable) {
    return {
      ackStatus: "failed",
      ackResult:
        `${parts.join("; ")}; systemd user manager unavailable — run: ` +
        "`lamasyncd --update` from a shell, then `systemctl --user restart lamasyncd.service`",
      restart: false,
    };
  }

  return {
    ackStatus: "done",
    ackResult: `${parts.join("; ")}${restart ? "; service restart requested" : ""}`,
    restart,
  };
}

/** Injected effects for `runDaemonUpdateAction` (all overridable in tests). */
export interface DaemonUpdateActionDeps {
  /**
   * Write the one terminal completion. Must resolve `true` only once the
   * server has durably recorded it; `false` means the ack failed.
   */
  ack: (status: "done" | "failed", result: string) => Promise<boolean>;
  systemdAvailable: () => boolean;
  restart: () => { ok: boolean; reason?: string };
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Optional secret scrubber for restart-failure reasons. */
  scrub?: (message: string) => string;
}

/**
 * Drive one `update_daemon` action to completion: plan the single terminal
 * ack, write it durably, and only then request the service restart.
 *
 * The ordering is the point (LAMA-311 review). `ack` is the durability gate:
 * when the completion could not be written, the restart is *not* requested,
 * because tearing the process down would strand the action in `taken` with no
 * recorded outcome — the boot reclaim / server reaper then re-executes it.
 * Leaving the daemon alive lets the normal poll/reclaim path retry it with a
 * working control plane.
 *
 * Returns the plan that was applied so callers can log it.
 */
export async function runDaemonUpdateAction(
  outcome: DaemonUpdateOutcome,
  deps: DaemonUpdateActionDeps,
): Promise<DaemonUpdateActionPlan> {
  const plan = planDaemonUpdateAction(outcome, {
    systemdAvailable: deps.systemdAvailable(),
  });
  const acked = await deps.ack(plan.ackStatus, plan.ackResult);
  if (!acked) {
    deps.logError?.(
      `[action] update_daemon: could not record the completion; not restarting ` +
        "(the action stays claimable and will be retried)",
    );
    return plan;
  }
  if (plan.restart) {
    const restarted = deps.restart();
    if (!restarted.ok) {
      const reason = restarted.reason ?? "unknown";
      const scrubbed = deps.scrub ? deps.scrub(reason) : reason;
      deps.logError?.(
        `[action] update_daemon restart failed: ${scrubbed}; ` +
          "run `systemctl --user restart lamasyncd.service`",
      );
    } else {
      deps.log?.(`[action] update_daemon: ${plan.ackResult}; restart issued`);
    }
  }
  return plan;
}
