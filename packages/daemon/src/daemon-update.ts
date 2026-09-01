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

export type DaemonUpdatePhase =
  | "preflight"
  | "release"
  | "asset"
  | "replace"
  | "restart";

export type DaemonUpdateOutcome =
  | { ok: true; changed: false; currentVersion: string; latestVersion: string }
  | {
      ok: true;
      changed: true;
      currentVersion: string;
      latestVersion: string;
      asset: string;
    }
  | { ok: false; phase: DaemonUpdatePhase; summary: string };

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
}

/**
 * Fixed daemon-asset selection for remotely initiated updates. Never
 * consults the environment; picks only the daemon's own assets — the
 * canonical `lamasyncd` binary or a `lamasyncd-*` per-platform variant.
 * Anything else (TUI, server, skill tarballs, `update.sh`) is rejected.
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

function fail(phase: DaemonUpdatePhase, summary: string): DaemonUpdateOutcome {
  return { ok: false, phase, summary };
}

/**
 * Run the full update flow with injected effects. Never throws — every
 * failure mode is a structured outcome so both callers (CLI and the
 * queued-action dispatcher) can surface a uniform, secret-free result.
 */
export async function performDaemonUpdate(
  deps: DaemonUpdateDeps,
): Promise<DaemonUpdateOutcome> {
  // ---- preflight: only facts needed to execute safely ----
  const { config } = deps;
  if (!config.serverUrl || config.serverUrl.length === 0) {
    return fail("preflight", "daemon config has no server URL");
  }
  if (!config.apiKey || config.apiKey.length === 0) {
    return fail("preflight", "daemon config has no credential");
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
      return fail("preflight", "server rejected the daemon credential");
    }
  }
  if (deps.checkRestartAvailable && !deps.checkRestartAvailable()) {
    return fail(
      "preflight",
      "systemd user manager unavailable; update manually with `lamasyncd --update` and restart lamasyncd.service",
    );
  }

  const binaryPath = (deps.resolveBinaryPath ?? resolveSelfBinaryPath)();
  if (
    !binaryPath ||
    !isAbsolute(binaryPath) ||
    binaryPath.endsWith("/bun") ||
    binaryPath.endsWith("/node")
  ) {
    return fail("preflight", "could not resolve a writable compiled daemon binary path");
  }
  const writable = deps.checkWritable ?? defaultCheckWritable;
  if (!writable(binaryPath)) {
    return fail("preflight", `binary path is not writable: ${binaryPath}`);
  }

  // ---- release metadata via the server's cached release proxy ----
  let latest: ReleaseInfo | null = null;
  try {
    latest = await deps.getLatestRelease();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail("release", scrubForOutcome(`release proxy failed: ${msg}`, config.apiKey));
  }
  if (!latest) {
    return fail("release", "release proxy unreachable or malformed");
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
    );
  }

  // ---- already current ----
  if (!isNewer(VERSION, latest.version)) {
    return {
      ok: true,
      changed: false,
      currentVersion: VERSION,
      latestVersion: latest.version,
    };
  }

  // ---- atomic replace ----
  let replaced = false;
  try {
    replaced = await deps.downloadAndReplace(asset.downloadUrl, binaryPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail("replace", scrubForOutcome(`binary replacement threw: ${msg}`, config.apiKey));
  }
  if (!replaced) {
    return fail("replace", `failed to download/replace the daemon binary from ${latest.tag}`);
  }

  return {
    ok: true,
    changed: true,
    currentVersion: VERSION,
    latestVersion: latest.version,
    asset: asset.name,
  };
}
