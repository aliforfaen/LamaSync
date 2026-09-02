// LAMA-299: pure tests for the injected daemon update helper. No network,
// no filesystem effects — every dependency is injected.
import { VERSION } from "@lamasync/core";
import type { ReleaseInfo } from "./self-update.ts";
import {
  performDaemonUpdate,
  scrubForOutcome,
  selectDaemonAsset,
  selectDaemonAssetLegacy,
  type DaemonUpdateDeps,
  type DaemonUpdateOutcome,
} from "./daemon-update.ts";

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
    const tui = release({
      assets: [{ name: "lamasync-tui", downloadUrl: "https://x", size: 1 }],
    });
    // Strict (remote path): the TUI asset is NOT a daemon asset.
    expect(selectDaemonAsset(tui)).toBeNull();
    // Legacy broad fallback (CLI miss path only).
    expect(selectDaemonAssetLegacy(tui)?.name).toBe("lamasync-tui");
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
