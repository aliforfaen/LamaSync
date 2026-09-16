// LAMA-299: pure tests for the injected daemon update helper. No network,
// no filesystem effects — every dependency is injected.
import { VERSION } from "@lamasync/core";
import { describe, expect, test } from "bun:test";
import type { ReleaseInfo } from "./self-update.ts";
import {
  performDaemonUpdate,
  planDaemonUpdateAction,
  runDaemonUpdateAction,
  scrubForOutcome,
  selectDaemonAsset,
  selectDaemonAssetLegacy,
  summarizeUnitReconcile,
  type DaemonUpdateDeps,
  type DaemonUpdateOutcome,
} from "./daemon-update.ts";
import type { DaemonUnitReconcileResult } from "./systemd.ts";

const API_KEY = "lmsk.abcdefgh1234.supersecretvalue";

function release(over: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return {
    tag: "v9.9.9",
    version: "9.9.9",
    publishedAt: "2026-09-01T00:00:00Z",
    assets: [{ name: "lamasyncd", downloadUrl: "https://example.invalid/lamasyncd", size: 1 }],
    ...over,
  };
}

function baseDeps(over: Partial<DaemonUpdateDeps> = {}): DaemonUpdateDeps {
  return {
    config: { serverUrl: "https://lama.example", apiKey: API_KEY },
    getLatestRelease: async () => release(),
    downloadAndReplace: async () => true,
    ...over,
  };
}

function assertNoSecretLeak(outcome: DaemonUpdateOutcome): void {
  const text = JSON.stringify(outcome);
  expect(text).not.toContain(API_KEY);
  expect(text).not.toContain("supersecretvalue");
}

describe("performDaemonUpdate", () => {
  test("no update available → ok, changed=false", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ getLatestRelease: async () => release({ tag: `v${VERSION}`, version: VERSION }) }),
    );
    // "no update" means latest == running version, whatever that is —
    // derive both from the generated VERSION so version bumps don't
    // break this test.
    expect(outcome).toEqual({
      ok: true,
      changed: false,
      currentVersion: VERSION,
      latestVersion: VERSION,
    });
    assertNoSecretLeak(outcome);
  });

  test("missing server URL → preflight failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ config: { serverUrl: "", apiKey: API_KEY } }),
    );
    expect(outcome).toEqual({
      ok: false,
      phase: "preflight",
      summary: "daemon config has no server URL",
    });
    assertNoSecretLeak(outcome);
  });

  test("missing credential → preflight failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ config: { serverUrl: "https://x", apiKey: "" } }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.phase).toBe("preflight");
    assertNoSecretLeak(outcome);
  });

  test("auth check failure → preflight failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ checkAuth: async () => false }),
    );
    expect(outcome).toMatchObject({ ok: false, phase: "preflight" });
    assertNoSecretLeak(outcome);
  });

  test("auth check throw → preflight failure (never propagates)", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        checkAuth: async () => {
          throw new Error(`401 boom ${API_KEY}`);
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: false, phase: "preflight" });
    assertNoSecretLeak(outcome);
  });

  test("systemd unavailable → preflight failure with manual instruction", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ checkRestartAvailable: () => false }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.phase).toBe("preflight");
      expect(outcome.summary).toContain("lamasyncd --update");
    }
    assertNoSecretLeak(outcome);
  });

  test("release proxy unreachable → release failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ getLatestRelease: async () => null }),
    );
    expect(outcome).toMatchObject({ ok: false, phase: "release" });
    assertNoSecretLeak(outcome);
  });

  test("release proxy throw → release failure, message scrubbed", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () => {
          throw new Error(`fetch failed with ${API_KEY}`);
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.phase).toBe("release");
    assertNoSecretLeak(outcome);
  });

  test("no compatible asset → asset failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () =>
          release({ assets: [{ name: "lamasync-tui", downloadUrl: "https://x", size: 1 }] }),
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.phase).toBe("asset");
    assertNoSecretLeak(outcome);
  });

  test("replace failure → replace failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ downloadAndReplace: async () => false }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.phase).toBe("replace");
    assertNoSecretLeak(outcome);
  });

  test("success → changed=true with asset name", async () => {
    const outcome = await performDaemonUpdate(baseDeps());
    expect(outcome).toMatchObject({
      ok: true,
      changed: true,
      latestVersion: "9.9.9",
      asset: "lamasyncd",
    });
    assertNoSecretLeak(outcome);
  });

  test("remote path ignores LAMASYNC_UPDATE_ASSET (no envAssetName passed)", async () => {
    let downloaded: string | null = null;
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () =>
          release({
            assets: [
              { name: "lamasync-tui", downloadUrl: "https://x/tui", size: 1 },
              { name: "lamasyncd", downloadUrl: "https://x/daemon", size: 2 },
            ],
          }),
        downloadAndReplace: async (_url, _path) => {
          void _url;
          void _path;
          downloaded = "called" as string | null;
          return true;
        },
      }),
    );
    expect(outcome).toMatchObject({ ok: true, changed: true, asset: "lamasyncd" });
    expect(downloaded as string | null).toBe("called");
  });

  test("CLI path honors envAssetName override", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        envAssetName: "lamasyncd-experimental",
        getLatestRelease: async () =>
          release({
            assets: [
              { name: "lamasyncd-experimental", downloadUrl: "https://x/e", size: 1 },
              { name: "lamasyncd", downloadUrl: "https://x/d", size: 2 },
            ],
          }),
      }),
    );
    expect(outcome).toMatchObject({ ok: true, changed: true, asset: "lamasyncd-experimental" });
  });

  test("unresolvable binary path → preflight failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ resolveBinaryPath: () => "lamasyncd" }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.phase).toBe("preflight");
    assertNoSecretLeak(outcome);
  });

  test("unwritable binary path → preflight failure", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ resolveBinaryPath: () => "/opt/lamasyncd/lamasyncd", checkWritable: () => false }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.phase).toBe("preflight");
      expect(outcome.summary).toContain("not writable");
    }
    assertNoSecretLeak(outcome);
  });
});

// ---------------------------------------------------------------------------
// LAMA-311: the unit reconcile runs inside the update flow, before the release
// lookup and before the "already current" short-circuit, and its result rides
// on every outcome so both callers can report it in a single ack.
// ---------------------------------------------------------------------------

describe("performDaemonUpdate unit reconcile (LAMA-311)", () => {
  const migrated: DaemonUnitReconcileResult = {
    status: "migrated",
    summary: "removed obsolete sandbox directive(s) [ProtectHome=read-only]",
    guidance: "systemctl --user restart lamasyncd.service",
    restartRequired: true,
  };
  const current: DaemonUnitReconcileResult = {
    status: "current",
    summary: "systemd unit is current",
    guidance: null,
    restartRequired: false,
  };
  const failed: DaemonUnitReconcileResult = {
    status: "failed",
    summary: "could not rewrite /home/u/.config/systemd/user/lamasyncd.service (EROFS)",
    guidance: "run `lamasyncd --update` from a shell, then daemon-reload + restart",
    // The unit file was not rewritten, so a restart would apply nothing.
    restartRequired: false,
  };

  test("a stale unit is migrated even when the binary is already current", async () => {
    let reconcileCalls = 0;
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () => release({ tag: `v${VERSION}`, version: VERSION }),
        reconcileUnit: () => {
          reconcileCalls += 1;
          return migrated;
        },
      }),
    );
    expect(reconcileCalls).toBe(1);
    expect(outcome).toMatchObject({
      ok: true,
      changed: false,
      unit: { status: "migrated", restartRequired: true },
    });
    assertNoSecretLeak(outcome);
  });

  test("a current unit is still reported as current (not omitted)", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () => release({ tag: `v${VERSION}`, version: VERSION }),
        reconcileUnit: () => current,
      }),
    );
    expect(outcome).toMatchObject({ ok: true, changed: false, unit: { status: "current" } });
  });

  test("reconcile runs before the release lookup and rides on a release failure", async () => {
    let reconcileCalls = 0;
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () => null,
        reconcileUnit: () => {
          reconcileCalls += 1;
          return migrated;
        },
      }),
    );
    expect(reconcileCalls).toBe(1);
    expect(outcome).toMatchObject({
      ok: false,
      phase: "release",
      unit: { status: "migrated" },
    });
  });

  test("reconcile runs before auth, so it survives an unreachable control plane", async () => {
    // LAMA-311 review: the migration is purely local, so the manual CLI path
    // must be able to fix the unit even when the server rejects us or is down.
    let reconcileCalls = 0;
    const outcome = await performDaemonUpdate(
      baseDeps({
        checkAuth: async () => false,
        reconcileUnit: () => {
          reconcileCalls += 1;
          return migrated;
        },
      }),
    );
    expect(reconcileCalls).toBe(1);
    expect(outcome).toMatchObject({
      ok: false,
      phase: "preflight",
      unit: { status: "migrated" },
    });
  });

  test("a thrown reconciler becomes a scrubbed failed unit result, never a throw", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        reconcileUnit: () => {
          throw new Error(`EROFS while reading ${API_KEY}`);
        },
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.unit?.status).toBe("failed");
    expect(outcome.unit?.summary).toContain("reconcile threw");
    assertNoSecretLeak(outcome);
  });

  test("a binary replacement carries the migrated unit result too", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({ reconcileUnit: () => migrated }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      changed: true,
      asset: "lamasyncd",
      unit: { status: "migrated" },
    });
  });

  test("a failed unit reconcile does not abort a successful binary update", async () => {
    let downloaded = false;
    const outcome = await performDaemonUpdate(
      baseDeps({
        reconcileUnit: () => failed,
        downloadAndReplace: async () => {
          downloaded = true;
          return true;
        },
      }),
    );
    expect(downloaded).toBe(true);
    expect(outcome).toMatchObject({ ok: true, changed: true, unit: { status: "failed" } });
    assertNoSecretLeak(outcome);
  });

  test("without a reconciler the outcome has no unit field (legacy shape)", async () => {
    const outcome = await performDaemonUpdate(
      baseDeps({
        getLatestRelease: async () => release({ tag: `v${VERSION}`, version: VERSION }),
      }),
    );
    expect(outcome).toEqual({
      ok: true,
      changed: false,
      currentVersion: VERSION,
      latestVersion: VERSION,
    });
  });
});

describe("summarizeUnitReconcile (LAMA-311)", () => {
  const current: DaemonUnitReconcileResult = {
    status: "current",
    summary: "systemd unit is current",
    guidance: null,
    restartRequired: false,
  };
  const migrated: DaemonUnitReconcileResult = {
    status: "migrated",
    summary: "removed obsolete sandbox directive(s)",
    guidance: "systemctl --user restart lamasyncd.service",
    restartRequired: true,
  };
  const skipped: DaemonUnitReconcileResult = {
    status: "skipped",
    summary: "has drop-ins in ~/.config/systemd/user/lamasyncd.service.d; not rewriting it",
    guidance: "remove ProtectHome/ReadWritePaths from the drop-in by hand",
    restartRequired: false,
  };
  const failed: DaemonUnitReconcileResult = {
    status: "failed",
    summary: "could not rewrite the unit (EROFS)",
    guidance: "systemctl --user daemon-reload && systemctl --user restart lamasyncd.service",
    restartRequired: true,
  };

  test("nothing to say for a current (or absent) unit", () => {
    expect(summarizeUnitReconcile(current)).toBeNull();
    expect(summarizeUnitReconcile(undefined)).toBeNull();
  });

  test("migrated asks the operator to restart when the caller will not", () => {
    expect(summarizeUnitReconcile(migrated)).toContain("restart lamasyncd.service");
    expect(summarizeUnitReconcile(migrated, { autoRestart: true })).toBe(
      "refreshed the systemd user unit",
    );
  });

  test("skipped and failed both carry their manual guidance", () => {
    expect(summarizeUnitReconcile(skipped)).toContain("drop-ins");
    expect(summarizeUnitReconcile(skipped)).toContain("by hand");
    expect(summarizeUnitReconcile(failed)).toContain("not refreshed");
    expect(summarizeUnitReconcile(failed)).toContain("daemon-reload");
  });
});

describe("planDaemonUpdateAction (LAMA-311 ack/restart race)", () => {
  const currentUnit: DaemonUnitReconcileResult = {
    status: "current",
    summary: "systemd unit is current",
    guidance: null,
    restartRequired: false,
  };
  const migratedUnit: DaemonUnitReconcileResult = {
    status: "migrated",
    summary: "removed obsolete sandbox directive(s)",
    guidance: "systemctl --user restart lamasyncd.service",
    restartRequired: true,
  };
  const failedUnit: DaemonUnitReconcileResult = {
    status: "failed",
    summary: "could not rewrite the unit (EROFS)",
    guidance: "run `lamasyncd --update` from a shell, then daemon-reload + restart",
    restartRequired: false,
  };
  const ok = { systemdAvailable: true };

  test("binary replaced → done, restart requested after the ack", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: true,
        currentVersion: "0.3.10",
        latestVersion: "0.3.11",
        asset: "lamasyncd",
        unit: currentUnit,
      },
      ok,
    );
    expect(plan).toEqual({
      ackStatus: "done",
      ackResult: "installed v0.3.11; service restart requested",
      restart: true,
    });
  });

  test("migrated unit alone (binary current) → done + restart", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: false,
        currentVersion: "0.3.11",
        latestVersion: "0.3.11",
        unit: migratedUnit,
      },
      ok,
    );
    expect(plan).toEqual({
      ackStatus: "done",
      ackResult: "refreshed systemd unit; service restart requested",
      restart: true,
    });
  });

  test("nothing to do → done with no restart", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: false,
        currentVersion: "0.3.11",
        latestVersion: "0.3.11",
        unit: currentUnit,
      },
      ok,
    );
    expect(plan).toEqual({
      ackStatus: "done",
      ackResult: "already at v0.3.11",
      restart: false,
    });
  });

  test("a skipped unit is reported alongside 'already current' and restarts nothing", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: false,
        currentVersion: "0.3.11",
        latestVersion: "0.3.11",
        unit: {
          status: "skipped",
          summary: "has drop-ins; not rewriting it",
          guidance: "edit the drop-in by hand",
          restartRequired: false,
        },
      },
      ok,
    );
    expect(plan.ackStatus).toBe("done");
    expect(plan.ackResult).toContain("already at v0.3.11");
    expect(plan.ackResult).toContain("drop-ins");
    expect(plan.restart).toBe(false);
  });

  test("failed unit + replaced binary → failed ack, guidance, but still restart", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: true,
        currentVersion: "0.3.10",
        latestVersion: "0.3.11",
        asset: "lamasyncd",
        unit: failedUnit,
      },
      ok,
    );
    expect(plan.ackStatus).toBe("failed");
    expect(plan.ackResult).toContain("installed v0.3.11");
    expect(plan.ackResult).toContain("systemd unit not refreshed");
    expect(plan.ackResult).toContain("daemon-reload");
    expect(plan.restart).toBe(true);
  });

  test("failed unit with a current binary → failed ack and no restart", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: false,
        currentVersion: "0.3.11",
        latestVersion: "0.3.11",
        unit: failedUnit,
      },
      ok,
    );
    // The unit file was not migrated, so a restart would change nothing.
    expect(plan.ackStatus).toBe("failed");
    expect(plan.restart).toBe(false);
  });

  test("update failure carries the unit result and never restarts", () => {
    const plan = planDaemonUpdateAction(
      { ok: false, phase: "release", summary: "release proxy unreachable", unit: migratedUnit },
      ok,
    );
    expect(plan.ackStatus).toBe("failed");
    expect(plan.ackResult).toContain("release: release proxy unreachable");
    expect(plan.ackResult).toContain("refreshed the systemd user unit");
    expect(plan.restart).toBe(false);
  });

  test("systemd vanishing between preflight and restart → failed ack, no restart", () => {
    const plan = planDaemonUpdateAction(
      {
        ok: true,
        changed: true,
        currentVersion: "0.3.10",
        latestVersion: "0.3.11",
        asset: "lamasyncd",
        unit: currentUnit,
      },
      { systemdAvailable: false },
    );
    expect(plan.ackStatus).toBe("failed");
    expect(plan.ackResult).toContain("systemd user manager unavailable");
    expect(plan.ackResult).toContain("systemctl --user restart lamasyncd.service");
    expect(plan.restart).toBe(false);
  });

  test("every plan is a single terminal decision (no second ack exists)", () => {
    // Guard rail for the contract itself: the plan type has exactly one
    // status/result pair, so callers cannot express the old double ack.
    const plans = [
      planDaemonUpdateAction(
        { ok: false, phase: "asset", summary: "none" },
        ok,
      ),
      planDaemonUpdateAction(
        {
          ok: true,
          changed: false,
          currentVersion: "0.3.11",
          latestVersion: "0.3.11",
        },
        ok,
      ),
    ];
    for (const plan of plans) {
      expect(["done", "failed"]).toContain(plan.ackStatus);
      expect(typeof plan.ackResult).toBe("string");
      expect(plan.ackResult.length).toBeGreaterThan(0);
    }
  });
});

describe("runDaemonUpdateAction (LAMA-311 durable ack → restart)", () => {
  function deps(over: Partial<Parameters<typeof runDaemonUpdateAction>[1]> = {}) {
    const acks: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    let restarts = 0;
    const providedRestart = over.restart;
    const providedAck = over.ack;
    const base = {
      ...over,
      ack: async (status: "done" | "failed", result: string) => {
        acks.push(`${status}:${result}`);
        return providedAck ? providedAck(status, result) : true;
      },
      systemdAvailable: over.systemdAvailable ?? (() => true),
      restart: () => {
        restarts += 1;
        return providedRestart ? providedRestart() : { ok: true };
      },
      log: (m: string) => logs.push(m),
      logError: (m: string) => errors.push(m),
    };
    return {
      deps: base,
      acks,
      logs,
      errors,
      restarts: () => restarts,
    };
  }

  const replaced: DaemonUpdateOutcome = {
    ok: true,
    changed: true,
    currentVersion: "0.3.10",
    latestVersion: "0.3.11",
    asset: "lamasyncd",
    unit: {
      status: "current",
      summary: "systemd unit is current",
      guidance: null,
      restartRequired: false,
    },
  };

  test("acks exactly once, then restarts", async () => {
    const h = deps();
    const plan = await runDaemonUpdateAction(replaced, h.deps);
    expect(h.acks).toEqual(["done:installed v0.3.11; service restart requested"]);
    expect(plan.restart).toBe(true);
    expect(h.restarts()).toBe(1);
  });

  test("NEVER restarts when the ack failed (action stays claimable)", async () => {
    const h = deps({ ack: async () => false });
    const plan = await runDaemonUpdateAction(replaced, h.deps);
    // The completion is what makes the restart safe: without it, a restart
    // would strand the action in `taken` with no recorded outcome.
    expect(plan.restart).toBe(true);
    expect(h.restarts()).toBe(0);
    expect(h.errors.join("\n")).toContain("not restarting");
  });

  test("no restart when nothing changed", async () => {
    const h = deps();
    await runDaemonUpdateAction(
      {
        ok: true,
        changed: false,
        currentVersion: "0.3.11",
        latestVersion: "0.3.11",
      },
      h.deps,
    );
    expect(h.restarts()).toBe(0);
  });

  test("a failed restart is logged but the ack is not rewritten", async () => {
    const h = deps({
      restart: () => ({ ok: false, reason: "exit 1: Unit not found" }),
    });
    await runDaemonUpdateAction(replaced, h.deps);
    expect(h.acks.length).toBe(1);
    expect(h.restarts()).toBe(1);
    expect(h.errors.join("\n")).toContain("restart failed");
    expect(h.errors.join("\n")).toContain("Unit not found");
  });

  test("a restart-failure reason can be scrubbed before logging", async () => {
    const h = deps({
      restart: () => ({ ok: false, reason: `failed with ${API_KEY}` }),
      scrub: (m: string) => scrubForOutcome(m, API_KEY),
    });
    await runDaemonUpdateAction(replaced, h.deps);
    const logged = h.errors.join("\n");
    expect(logged).not.toContain(API_KEY);
    expect(logged).toContain("[redacted]");
  });

  test("planDaemonUpdateAction is applied verbatim (one plan, one ack)", async () => {
    const h = deps();
    const expected = planDaemonUpdateAction(replaced, { systemdAvailable: true });
    const plan = await runDaemonUpdateAction(replaced, h.deps);
    expect(plan).toEqual(expected);
    expect(h.acks).toEqual([`${expected.ackStatus}:${expected.ackResult}`]);
  });
});

describe("selectDaemonAsset", () => {
  test("prefers the exact lamasyncd asset", () => {
    const r = release({
      assets: [
        { name: "lamasync-tui", downloadUrl: "https://x", size: 1 },
        { name: "lamasyncd", downloadUrl: "https://x", size: 2 },
        { name: "lamasyncd-arm64", downloadUrl: "https://x", size: 3 },
      ],
    });
    expect(selectDaemonAsset(r)?.name).toBe("lamasyncd");
  });

  test("falls back to lamasyncd-*; rejects non-daemon lamasync-* assets", () => {
    const prefixed = release({
      assets: [{ name: "lamasyncd-linux-x64", downloadUrl: "https://x", size: 1 }],
    });
    expect(selectDaemonAsset(prefixed)?.name).toBe("lamasyncd-linux-x64");
    const legacyCli = release({
      assets: [{ name: "lamasync-tui", downloadUrl: "https://x", size: 1 }],
    });
    // Strict remote path: a legacy CLI compatibility asset is not a daemon asset.
    expect(selectDaemonAsset(legacyCli)).toBeNull();
    // Legacy broad fallback (CLI miss path only).
    expect(selectDaemonAssetLegacy(legacyCli)?.name).toBe("lamasync-tui");
    expect(selectDaemonAsset(release({ assets: [] }))).toBeNull();
  });
});

describe("scrubForOutcome", () => {
  test("removes the daemon API key", () => {
    const out = scrubForOutcome(`request to https://x?token=${API_KEY} failed`, API_KEY);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain("[redacted]");
  });

  test("removes bearer tokens and KEY=value secrets", () => {
    const out = scrubForOutcome("Authorization: Bearer abc.def and KEY=hunter2 and password=pw");
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("=pw");
  });
});
