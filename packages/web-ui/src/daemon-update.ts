// LAMA-299: pure UI-state helpers for the Host-detail "Software" section.
// Kept framework-free so every capability state is unit-testable; the
// HostDetail page renders whatever this module derives.
import type { Host, QueuedAction } from "@lamasync/core";
import {
  REMOTE_DAEMON_UPDATE_MIN_VERSION,
  daemonSupportsRemoteUpdate,
} from "@lamasync/core/remote-update";
import { isNewer } from "@lamasync/core/version-compare";

export type DaemonUpdateUiState =
  | { kind: "offline"; message: string }
  | { kind: "no-version"; message: string }
  | { kind: "daemon-too-old"; message: string; minVersion: string }
  | { kind: "no-release-info"; message: string }
  | { kind: "no-update"; message: string; installed: string; latest: string }
  | { kind: "ready"; message: string; installed: string; latest: string }
  | { kind: "in-flight"; message: string };

/**
 * Derive the capability state for the "Update daemon" button. The button
 * is offered ONLY when the host is online, reports a version, that
 * version is at or above REMOTE_DAEMON_UPDATE_MIN_VERSION, release info
 * is available, and the latest release is strictly newer. Anything else
 * renders an explanatory disabled state — never a job that cannot
 * succeed (an older daemon would mark `update_daemon` as unknown).
 */
export function daemonUpdateUiState(
  host: Pick<Host, "status" | "version">,
  latestVersion: string | null | undefined,
  hasInFlightAction: boolean,
): DaemonUpdateUiState {
  if (hasInFlightAction) {
    return { kind: "in-flight", message: "update already queued or in progress" };
  }
  if (host.status !== "online") {
    return { kind: "offline", message: "device is offline; update will not be offered" };
  }
  if (!host.version) {
    return {
      kind: "no-version",
      message: "device has not reported a version; update manually with `lamasyncd --update`",
    };
  }
  if (!daemonSupportsRemoteUpdate(host.version)) {
    return {
      kind: "daemon-too-old",
      message:
        `this device runs v${host.version}, which does not accept remote updates; ` +
        "run `lamasyncd --update` on the device once, then this button unlocks",
      minVersion: REMOTE_DAEMON_UPDATE_MIN_VERSION,
    };
  }
  if (!latestVersion) {
    return { kind: "no-release-info", message: "latest release unknown; try again shortly" };
  }
  if (!isNewer(host.version, latestVersion)) {
    return {
      kind: "no-update",
      message: `already at the latest release (v${host.version})`,
      installed: host.version,
      latest: latestVersion,
    };
  }
  return {
    kind: "ready",
    message: `update available: v${host.version} → v${latestVersion}`,
    installed: host.version,
    latest: latestVersion,
  };
}

/**
 * The most recent `update_daemon` action for the host, or null.
 * Terminal actions (done/failed) count — the Software section uses the
 * result line as the follow-up status after the daemon restarts.
 */
export function latestRemoteUpdateAction(actions: readonly QueuedAction[]): QueuedAction | null {
  const updates = actions
    .filter((a) => a.type === "update_daemon")
    .sort((a, b) => b.createdAt - a.createdAt);
  return updates[0] ?? null;
}

export type RemoteUpdateFollowUp =
  | { kind: "queued"; message: string }
  | { kind: "claimed"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "awaiting-heartbeat"; message: string }
  | { kind: "updated"; message: string }
  | { kind: "mismatch"; message: string };

/**
 * Follow-up status after an `update_daemon` action exists: the daemon
 * acks BEFORE restarting, so `done` means "binary replaced" — the new
 * version only becomes visible on the next heartbeat. Compare the
 * reported version to the version named in the ack result.
 */
export function remoteUpdateFollowUp(
  action: QueuedAction | null,
  reportedVersion: string | null | undefined,
): RemoteUpdateFollowUp | null {
  if (!action) return null;
  switch (action.status) {
    case "pending":
      return { kind: "queued", message: "update queued — the device will claim it within ~30 s" };
    case "taken":
      return { kind: "claimed", message: "device claimed the update; downloading and replacing" };
    case "failed":
      return {
        kind: "failed",
        message: action.result ?? "update failed on the device",
      };
    case "done": {
      const target = parseInstalledVersion(action.result ?? "");
      if (!target) {
        // e.g. "already at v0.3.6" — nothing was installed.
        return { kind: "updated", message: action.result ?? "up to date" };
      }
      if (!reportedVersion) {
        return {
          kind: "awaiting-heartbeat",
          message: `installed v${target}; waiting for the next heartbeat to confirm`,
        };
      }
      if (versionEquals(reportedVersion, target)) {
        return { kind: "updated", message: `updated to v${target}` };
      }
      return {
        kind: "awaiting-heartbeat",
        message: `installed v${target}; device still reports v${reportedVersion} — waiting for heartbeat`,
      };
    }
  }
}

/** Extract "installed vX" / "updated to vX" / "vX" from an ack result. */
export function parseInstalledVersion(result: string): string | null {
  const m = /installed v(\d+\.\d+\.\d+)/.exec(result) ?? /^v(\d+\.\d+\.\d+)/.exec(result);
  return m?.[1] ?? null;
}

function versionEquals(a: string, b: string): boolean {
  const pa = a.trim().replace(/^[vV]/, "");
  const pb = b.trim().replace(/^[vV]/, "");
  return pa === pb;
}
