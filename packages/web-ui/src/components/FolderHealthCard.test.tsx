// LAMA-345 — the Folder health card's rendered surface.
//
// Repo convention: no jsdom. `react-dom/server` static markup pins the copy
// and the offered actions an operator actually sees (effects do not run, so
// the guided modal is never opened here — its pure gating rules live in
// ../folder-health.test.ts).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  FolderHealthFacts,
  FolderHealthRecord,
  FolderPlanWithValidity,
} from "@lamasync/core/folder-health";
import {
  FolderHealthCard,
  FolderHealthWizard,
  FolderHealthWizardFooter,
} from "./FolderHealthCard.tsx";

function facts(overrides: Partial<FolderHealthFacts> = {}): FolderHealthFacts {
  return {
    folderType: "sync",
    effectiveType: "sync",
    enabled: true,
    paused: false,
    runInProgress: false,
    rcloneAvailable: true,
    localDir: "ok",
    freeSpaceBytes: 10_000_000_000,
    freeSpaceThresholdBytes: 1_000_000_000,
    watcher: { enabled: true, running: true, quietSec: 30 },
    filter: { fingerprint: "fp", source: "lamasyncignore", changedSinceBaseline: false },
    baseline: {
      present: true,
      ready: true,
      error: false,
      path1Count: 42,
      path2Count: 42,
      updatedAt: 1,
      fingerprint: "base",
    },
    activePhase: null,
    pendingConflicts: 0,
    lastRun: { status: "success", summary: "sync ok", at: 1 },
    measurement: null,
    ...overrides,
  };
}

function record(overrides: Partial<FolderHealthRecord> = {}): FolderHealthRecord {
  return {
    assignmentId: "a1",
    folderId: "f1",
    hostId: "dev-vm",
    state: "healthy",
    reasons: [
      { code: "ok", message: "Baseline is paired and the last run agreed.", remediation: "Nothing to do.", action: null },
    ],
    facts: facts(),
    reportedAt: Date.now(),
    stale: false,
    stalenessMs: 30_000,
    measurementAgeMs: null,
    active: false,
    ...overrides,
  };
}

function render(props: Parameters<typeof FolderHealthCard>[0]): string {
  return renderToStaticMarkup(<FolderHealthCard {...props} />);
}

describe("FolderHealthCard", () => {
  test("shows the state word, the reason and the remediation", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("Healthy");
    expect(html).toContain("Baseline is paired and the last run agreed.");
    expect(html).toContain("Nothing to do.");
  });

  test("states the sync record, ignore set, watching and last-run facts", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("Sync record paired (remote 42 · this device 42)");
    expect(html).toContain(".lamasyncignore");
    expect(html).toContain("Watching for changes (settles after 30s of quiet)");
    expect(html).toContain("sync ok");
  });

  test("offers a plain-language glossary instead of jargon", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("What do these terms mean?");
    expect(html).toContain("Sync record (baseline)");
    expect(html).toContain("never means &#x27;no limit&#x27;");
    // Path 1/Path 2 vocabulary must not appear in the card's summary surface.
    expect(html).not.toContain("Path 1");
    expect(html).not.toContain("--resync-mode");
  });

  test("status and error regions are announced politely/assertively", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
  });

  test("never presents an unmeasured folder as measured", () => {
    const html = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(html).toContain("Not measured");
  });

  test("offers Sync now only with a ready baseline", () => {
    const ready = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    expect(ready).toContain("Sync now");
    expect(ready).not.toContain("Set up this device from the remote");
    // No context-free plan action anywhere on the card.
    expect(ready).not.toContain("Preview changes");

    const unseeded = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({
        state: "new_host",
        reasons: [
          {
            code: "baseline_missing",
            message: "No baseline yet.",
            remediation: "Initialize this host from remote.",
            action: "initialize",
          },
        ],
        facts: facts({
          baseline: {
            present: false,
            ready: false,
            error: false,
            path1Count: null,
            path2Count: null,
            updatedAt: null,
            fingerprint: "none",
          },
        }),
      }),
    });
    expect(unseeded).not.toContain("Sync now");
    expect(unseeded).toContain("Set up this device from the remote");
    expect(unseeded).toContain("Fill the remote from this device");
  });

  test("a stale report is labelled stale", () => {
    const html = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({ stale: true, stalenessMs: 3 * 60 * 60_000 }),
    });
    expect(html).toContain("stale");
  });

  test("a running assignment shows the running badge and an explicit Stop action", () => {
    const html = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({ state: "busy", active: true }),
    });
    expect(html).toContain("running");
    expect(html).toContain("Stop current run");
    expect(html).not.toContain("Sync now");
  });

  test("checking and syncing are visually distinct from rebaseline and stop", () => {
    const healthy = render({ folderId: "f1", hostId: "dev-vm", record: record() });
    // Check is neutral; Sync now is primary; Rebuild is danger.
    expect(healthy).toContain('class="action">Check this device now');
    expect(healthy).toContain('class="action primary">Sync now');
    expect(healthy).toContain('class="action danger">Rebuild the sync baseline');

    const running = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({ state: "busy", active: true }),
    });
    expect(running).toContain('class="action danger"');
  });

  test("an unusable baseline is called out as a critical error", () => {
    const html = render({
      folderId: "f1",
      hostId: "dev-vm",
      record: record({
        state: "unsafe",
        facts: facts({
          baseline: {
            present: true,
            ready: false,
            error: true,
            path1Count: null,
            path2Count: null,
            updatedAt: 1,
            fingerprint: "p",
          },
        }),
      }),
    });
    expect(html).toContain("critical error");
    expect(html).toContain("Rebuild the sync baseline");
  });
});

// ---------------------------------------------------------------------------
// The guided wizard. Rendered from props so each of the four steps can be
// pinned without a DOM or a live daemon.
// ---------------------------------------------------------------------------

function planEntry(over: {
  intervention?: "initialize" | "seed" | "resync";
  authority?: "remote" | "local";
  maxDeletePercent?: number | null;
  valid?: boolean;
  changes?: FolderPlanWithValidity["plan"]["changes"];
} = {}): FolderPlanWithValidity {
  return {
    plan: {
      id: "plan-1",
      hostId: "dev-vm",
      folderId: "f1",
      assignmentId: "a1",
      intervention: over.intervention ?? "seed",
      authority: over.authority ?? "local",
      maxDeletePercent: over.maxDeletePercent ?? 10,
      summary: "Fill the remote from this device — this device wins conflicting files.",
      changes: over.changes ?? {
        wouldCopy: ["a.txt", "b.txt"],
        wouldDelete: ["c.txt"],
        wouldMkdir: ["newdir"],
        files: 2,
        bytes: 2048,
      },
      configRevision: 9,
      filterFingerprint: "fp",
      baselineFingerprint: "base",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    },
    validity: over.valid === false
      ? { valid: false, reason: "expired", message: "This plan has expired — plan again." }
      : { valid: true, reason: null, message: "Plan is current." },
  };
}

function wizardProps(over: Partial<Parameters<typeof FolderHealthWizard>[0]> = {}) {
  return {
    action: "seed" as const,
    stage: "choose" as const,
    authority: "local" as const,
    maxDeletePercent: null,
    plan: null,
    error: null,
    nextStep: null,
    onAuthorityChange: () => {},
    onMaxDeletePercentChange: () => {},
    ...over,
  };
}

function renderWizard(over: Partial<Parameters<typeof FolderHealthWizard>[0]> = {}): string {
  return renderToStaticMarkup(<FolderHealthWizard {...wizardProps(over)} />);
}

describe("FolderHealthWizard — step 1 (choose)", () => {
  test("explains the purpose and the fixed side for an operation that cannot choose", () => {
    const html = renderWizard({ action: "seed" });
    expect(html).toContain("You will see exactly what would be copied and deleted");
    // Seed has a fixed side, so no chooser is offered.
    expect(html).not.toContain("Which version should win");
    expect(html).toContain("This device wins conflicting files");
    expect(html).toContain("Files that exist on only one side are copied to the other side.");
  });

  test("rebuild offers the side chooser and its consequence", () => {
    const html = renderWizard({ action: "resync", authority: "remote" });
    expect(html).toContain("Which version should win when a file changed on both sides?");
    expect(html).toContain("Keep the remote");
    expect(html).toContain("Keep this device");
  });

  test("the deletion threshold is labelled as a percentage with a real default", () => {
    const html = renderWizard();
    expect(html).toContain("Deletion threshold (per cent)");
    expect(html).toContain("50%, never");
    expect(html).toContain("no limit");
    // Associated label + autofill off on the new inputs.
    expect(html).toContain('for="folder-health-maxdelete"');
    expect(html).toContain('id="folder-health-maxdelete"');
    // react-dom/server in this Bun build passes the JSX prop casing through;
    // assert case-insensitively so the check is about the attribute existing.
    expect(html.toLowerCase()).toContain('autocomplete="off"');
  });

  test("rclone vocabulary lives only in the technical-details disclosure", () => {
    const html = renderWizard({ action: "seed" });
    const detailsIndex = html.indexOf("Technical details");
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(html.indexOf("Path 1")).toBeGreaterThan(detailsIndex);
  });

  test("a failure shows the reason and a concrete next step", () => {
    const html = renderWizard({
      stage: "failed",
      error: "planning failed: preview timed out after 60s",
      nextStep: "Raise the timeout in Advanced settings, then preview again.",
    });
    expect(html).toContain("preview timed out");
    expect(html).toContain("Raise the timeout in Advanced settings");
  });
});

describe("FolderHealthWizard — step 3 (review)", () => {
  test("totals are shown separately from the sample list", () => {
    const html = renderWizard({ stage: "review", plan: planEntry() });
    expect(html).toContain("To copy");
    expect(html).toContain("To delete");
    expect(html).toContain("Folders to create");
    expect(html).toContain("2.0 KiB");
    expect(html).toContain("Sample of what would change");
  });

  test("deletions get a visible warning before approval", () => {
    const html = renderWizard({ stage: "review", plan: planEntry() });
    expect(html).toContain("deletes 1 item");
    expect(html).toContain("folder-health-warning");
  });

  test("a clean plan says so instead of warning", () => {
    const html = renderWizard({
      stage: "review",
      plan: planEntry({
        changes: { wouldCopy: ["a"], wouldDelete: [], wouldMkdir: [], files: 1, bytes: 10 },
      }),
    });
    expect(html).toContain("Nothing would be deleted by this plan.");
  });

  test("a capped sample list is disclosed as only the first N", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}`);
    const html = renderWizard({
      stage: "review",
      plan: planEntry({
        changes: { wouldCopy: many, wouldDelete: [], wouldMkdir: [], files: 20, bytes: 0 },
      }),
    });
    expect(html).toContain("keeps the first 20 entries per list");
  });

  test("a plan for a different side than the one selected is refused on screen", () => {
    // The plan was reviewed with the remote winning; the operator asked for
    // this device to win. The review step must not present it as runnable.
    const html = renderWizard({
      stage: "review",
      action: "resync",
      authority: "remote",
      maxDeletePercent: 10,
      plan: planEntry({ intervention: "resync", authority: "local", maxDeletePercent: 10 }),
    });
    expect(html).toContain("Plan again with the side you want");
    expect(html).not.toContain("This preview is still current.");
  });

  test("a plan for a different threshold than the one selected is refused on screen", () => {
    const html = renderWizard({
      stage: "review",
      maxDeletePercent: 90,
      plan: planEntry({ authority: "local", maxDeletePercent: 10 }),
    });
    expect(html).toContain("deletion threshold");
    expect(html).toContain("90%");
  });

  test("an expired plan is called out", () => {
    const html = renderWizard({ stage: "review", plan: planEntry({ valid: false }) });
    expect(html).toContain("This plan has expired");
  });
});

describe("FolderHealthWizardFooter", () => {
  const base = {
    action: "seed" as const,
    busy: false,
    hasPlan: false,
    onClose: () => {},
    onPreview: () => {},
    onApprove: () => {},
    onRetry: () => {},
  };

  test("step 1 offers preview, not approval", () => {
    const html = renderToStaticMarkup(<FolderHealthWizardFooter {...base} stage="choose" />);
    expect(html).toContain("Preview changes");
    expect(html).not.toContain("Run it now");
  });

  test("step 3 is the only place approval appears, and it needs a plan", () => {
    const withoutPlan = renderToStaticMarkup(
      <FolderHealthWizardFooter {...base} stage="review" hasPlan={false} />,
    );
    expect(withoutPlan).toContain("Run it now");
    expect(withoutPlan).toContain("disabled");

    const withPlan = renderToStaticMarkup(
      <FolderHealthWizardFooter {...base} stage="review" hasPlan />,
    );
    expect(withPlan).toContain("Run it now");
    expect(withPlan).not.toContain("disabled");
  });

  test("a failure offers preview again rather than a dead end", () => {
    const html = renderToStaticMarkup(<FolderHealthWizardFooter {...base} stage="failed" />);
    expect(html).toContain("Preview again");
    expect(html).not.toContain("Run it now");
  });

  test("the executing step is close-only", () => {
    const html = renderToStaticMarkup(<FolderHealthWizardFooter {...base} stage="executing" />);
    expect(html).toContain("Close");
    expect(html).not.toContain("Preview changes");
    expect(html).not.toContain("Run it now");
  });
});
