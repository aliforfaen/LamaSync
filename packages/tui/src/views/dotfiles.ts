// Dotfiles view (ViewId "dotfiles"): lists this host's app protections from
// the server and lets the user inspect each snapshot archive. Target-side
// restore is deliberately unavailable until the setup-plan executor supplies
// preflight, conflict choices, and rollback. Implements the foundation `View`
// contract — the outer container
// is built once in the constructor; per-step refreshes mutate only the body
// Box (cheap). The legacy `DotfilesController` / `RenderDotfilesOpts` types
// remain exported as a back-compat surface, but the runtime `renderDotfiles`
// factory was removed in the LAMA-173 review passes — the only caller was the
// now-retired `packages/tui/src/index.ts` shell entry, and the View contract
// drives the new boot path.

import {
  Box,
  Input,
  MarkdownRenderable,
  Select,
  SyntaxStyle,
  Text,
} from "@opentui/core";
import type {
  BoxRenderable,
  CliRenderer,
  KeyEvent,
  Renderable,
  RenderContext,
  VNode,
} from "@opentui/core";
import { mkdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type {
  ApplicationProtectionListItem,
  ApplicationSnapshot,
  Folder,
  LamaSyncApiClient,
} from "@lamasync/core";

import { hotkeyFooter, pageShell, realize, swapChildren } from "../app/widgets.ts";
import { formatMarkdownText } from "../markdown.ts";
import { PALETTE_BG, SELECTION } from "../app/palette.ts";
import { friendlyError } from "../friendly-error.ts";
import type { Hotkey } from "../app/keymap.ts";
import { matchHotkey } from "../app/keymap.ts";
import type {
  View,
  ViewContext,
  ViewId,
} from "../app/view-manager.ts";
import { computeRestoreDiff, formatDiffPreview } from "../dotfiles-diff.ts";

// -----------------------------------------------------------------------------
// Public types — kept stable for any consumer still importing the pre-slice
// names. The action surface narrows to the gestures the View exposes:
// refresh and back to the previous step.
// -----------------------------------------------------------------------------

export type DotfilesAction = "refresh" | "menu" | "quit" | "back";

type Step =
  | "app"
  | "snapshot"
  | "preview"
  | "extract"
  | "subpaths"
  | "confirm"
  | "done"
  | "setup";

export interface DotfilesState {
  step: Step;
  /** Protections bound to the current host (list rows carry template
   *  identity + latest snapshot so the picker needs no extra fetches). */
  protections: ApplicationProtectionListItem[];
  backupFolders: BackupFolderRow[];
  /** Selected protection id + display name for the browse steps. */
  protectionId: string | null;
  protectionName: string | null;
  /** Selected protection's capture-spec notes (restore instructions). */
  instructions: string | null;
  snapshots: ApplicationSnapshot[];
  snapshot: ApplicationSnapshot | null;
  previewText: string;
  previewError: string | null;
  /**
   * Absolute path to the downloaded tarball on disk. Populated by
   * `selectSnapshot` once the preview step has a successful tar -tzf read;
   * reused by the confirm-step diff and the actual extract so we never
   * re-download. Cleared on a fresh snapshot pick.
   */
  extractStagingDir: string | null;
  /**
   * Body text shown on the confirm step: `null` while the diff is still
   * computing, a short multi-line string once `runConfirmStep` finishes.
   */
  confirmPreview: string | null;
  /** Surface message when the diff lookup fails (e.g. tar -tzf exit≠0). */
  confirmError: string | null;
  extractTarget: string;
  extractSubpaths: string;
  extractResult: string | null;
  loadError: string | null;
}

export interface RenderDotfilesOpts {
  api: LamaSyncApiClient;
  currentHostId: string;
  ctx: RenderContext;
  onAction: (action: DotfilesAction) => void;
}

export interface DotfilesController {  view: VNode;
  handleKey: (e: KeyEvent) => void;
  state: DotfilesState;
  onAction: (action: DotfilesAction) => void;}

// -----------------------------------------------------------------------------
// Constants — mirrored from the original `dotfiles.ts` so the step transitions
// match the legacy `renderDotfiles` behavior.
// -----------------------------------------------------------------------------

const STEP_BACK: Record<Step, Step> = {
  app: "app",
  snapshot: "app",
  preview: "snapshot",
  extract: "preview",
  subpaths: "extract",
  confirm: "subpaths",
  done: "app",
  setup: "app",
};

/** Protection-row description: notes, template, schedule, latest snapshot. */
function describeProtectionRow(p: ApplicationProtectionListItem): string {
  const parts: string[] = [];
  const notes = p.captureSpec.notes?.trim();
  if (notes) parts.push(notes);
  const templateLabel = p.templateEmoji
    ? `${p.templateEmoji} ${p.templateName}`
    : p.templateName;
  if (templateLabel && templateLabel !== p.name) parts.push(templateLabel);
  if (p.latestSnapshot) {
    parts.push(`latest ${new Date(p.latestSnapshot.createdAt).toLocaleString()}`);
  }
  if (!p.enabled) parts.push("disabled");
  else if (p.schedule) parts.push(`schedule: ${p.schedule}`);
  return parts.length > 0 ? parts.join(" — ") : "app snapshots";
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

interface AppRow {
  name: string;
  description: string;
  value: string;
}

/**
 * The legacy restore path is intentionally additive until the guided
 * migration executor exists. `--skip-old-files` means an existing target
 * entry is never overwritten; the preview makes those preserved entries
 * visible before the command runs.
 */
export function preservingExtractArgs(
  tarPath: string,
  target: string,
  subpaths: string[],
): string[] {
  return ["tar", "xzf", "--skip-old-files", tarPath, "-C", target, ...subpaths];
}

/** Fleet-wide backup-type folder, rendered as a read-only visibility list. */
interface BackupFolderRow {
  name: string;
  description: string;
}

/** Storage-destination kind label for a backup folder row (glossary: backend → storage destination). */
function describeBackupFolder(f: Folder): string {
  const parts: string[] = [];
  if (f.backend) parts.push(f.backend);
  if (f.s3Bucket) parts.push(f.s3Bucket);
  if (f.encrypted) parts.push("encrypted");
  return parts.length > 0 ? parts.join(" · ") : "storage destination";
}

interface SnapshotRow {
  name: string;
  description: string;
  value: string;
}

/**
 * Dotfiles browser + restore view. Implements the foundation `View` contract.
 * The container is built once in the constructor; per-step refreshes swap the
 * body Box's children. The Enter key advances within the state machine; the
 * Shell dispatches `r` through the hotkey table.
 */
export class DotfilesView implements View {
  static readonly id: ViewId = "dotfiles";
  static readonly title = "Backups & apps";

  readonly id: ViewId = DotfilesView.id;
  readonly title: string = DotfilesView.title;

  private readonly bodyBox: BoxRenderable;
  private readonly syntaxStyle: SyntaxStyle;
  private readonly markdownCtx: RenderContext | null;

  private readonly state: DotfilesState = {
    step: "app",
    protections: [],
    backupFolders: [],
    protectionId: null,
    protectionName: null,
    instructions: null,
    snapshots: [],
    snapshot: null,
    previewText: "",
    previewError: null,
    extractStagingDir: null,
    confirmPreview: null,
    confirmError: null,
    extractTarget: "/",
    extractSubpaths: "",
    extractResult: null,
    loadError: null,
  };

  private ctx: ViewContext | null = null;
  private loadId = 0;
  private rootCtx: RenderContext | null = null;
  private readonly renderer: CliRenderer | null;
  /** Focused extract-step Input, blurred before the next body swap. */
  private activeInput: { focus?: () => void; blur?: () => void } | null = null;

  readonly container: Renderable;


  constructor(opts: { ctx: ViewContext; rootCtx?: RenderContext }) {
    this.renderer = opts.ctx.renderer ?? null;
    this.bodyBox = realize<BoxRenderable>(
      opts.ctx.renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    );
    this.syntaxStyle = SyntaxStyle.create();
    // MarkdownRenderable needs a real `RenderContext`; the View doesn't own
    // the renderer so callers (boot.ts) may pass one in. When unset the
    // preview step renders the raw text in a Text node instead.
    this.markdownCtx = opts.rootCtx ?? null;
    this.rootCtx = opts.rootCtx ?? null;
    this.container = realize<Renderable>(
      opts.ctx.renderer,
      pageShell(
        "Backups & apps",
        Box({ flexDirection: "column", flexGrow: 1 }, this.bodyBox),
      ),
    );
    // Defer first paint to onShow(): the protection list comes from the API,
    // so there is nothing meaningful to render before then.
  }

  // ---------------------------------------------------------------------------
  // Hotkeys — refresh the protection list.
  // ---------------------------------------------------------------------------

  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "r", label: "refresh", run: () => void this.refresh() },
    ];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    // First paint — bodyBox is a real renderable, so mutations render live.
    this.renderBody();
    void this.refresh();
  }

  onHide(): void {
    this.loadId++;
    this.ctx = null;
  }

  handleKey(e: KeyEvent): boolean {
    const name = typeof e.name === "string" ? e.name : "";
    const raw = typeof e.raw === "string" ? e.raw : "";
    const char = raw.length === 1 ? raw.toLowerCase() : "";

    if (name === "escape") {
      if (this.state.step === "app") {
        return false;
      }
      this.state.step = STEP_BACK[this.state.step];
      this.renderBody();
      return true;
    }
    if (name === "return" || name === "enter") {
      if (this.state.step === "preview") {
        // A tar listing is safe to inspect, but extraction is not a recovery
        // plan. Do not turn this legacy browser into an implicit target-side
        // restore path while LAMA-310's guarded executor is still pending.
        return true;
      }
      if (this.state.step === "confirm") {
        // Read-only until the user explicitly confirms. LAMA-173 semantics:
        // the body Text on the confirm step is the focused widget, so its
        // Enter handler is what actually fires `extractTarball`. Esc from
        // confirm already steps back via STEP_BACK at the top of handleKey.
        if (
          this.state.confirmError === null &&
          this.state.snapshot !== null &&
          this.state.extractStagingDir !== null
        ) {
          void this.runConfirmedExtract();
        }
        return true;
      }
      if (this.state.step === "done") {
        this.state.step = "app";
        this.renderBody();
        return true;
      }
    }

    const match = matchHotkey(this.hotkeys(), name, char);
    if (!match) return false;
    void Promise.resolve(match.run());
    return true;
  }

  // ---------------------------------------------------------------------------
  // State-machine actions
  // ---------------------------------------------------------------------------


  private async refresh(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const loadId = ++this.loadId;
    try {
      // Protections are the interactive part; folders are a visibility list,
      // so a folders-fetch failure must not blank the protection picker.
      const [protections, folders] = await Promise.all([
        ctx.api.listAppProtections(ctx.hostname),
        ctx.api.listFolders().catch(() => [] as Folder[]),
      ]);
      if (loadId !== this.loadId) return;
      this.state.backupFolders = folders
        .filter((f) => f.type === "backup")
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((f) => ({ name: f.name, description: describeBackupFolder(f) }));
      this.state.protections = protections;
      this.state.loadError = null;
      // If the host has no protections, route to the setup step so the body
      // explains how to bootstrap. The user can press r again once a
      // protection exists to return to the picker.
      if (this.state.protections.length === 0 && this.state.step === "app") {
        this.state.step = "setup";
        this.state.extractResult =
          "No app protections on this host yet — enroll one with `lamasync apps protections enroll` (or the Web UI), then press r.";
      }
      // P1 (TuiDotfilesGh.ReviewDotfilesGh): if we were stuck on setup
      // because protections were empty, but a new refresh now surfaces some,
      // drop back to the protection picker so the user can actually pick one.
      if (this.state.protections.length > 0 && this.state.step === "setup") {
        this.state.step = "app";
        this.state.extractResult = null;
      }
    } catch (err) {
      if (loadId !== this.loadId) return;
      this.state.loadError = friendlyError(err);
      this.state.protections = [];
    }
    this.renderBody();
  }

  private async selectProtection(protectionId: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const loadId = ++this.loadId;
    const protection = this.state.protections.find((p) => p.id === protectionId);
    this.state.protectionId = protectionId;
    this.state.protectionName = protection?.name ?? null;
    this.state.instructions = protection?.captureSpec.notes ?? null;
    try {
      const snapshots = await ctx.api.listAppSnapshots(protectionId);
      if (loadId !== this.loadId) return;
      this.state.snapshots = snapshots;
      this.state.step = "snapshot";
    } catch (err) {
      if (loadId !== this.loadId) return;
      this.state.snapshots = [];
      this.state.loadError = friendlyError(err);
    }
    this.renderBody();
  }

  private async selectSnapshot(snapshot: ApplicationSnapshot): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.state.snapshot = snapshot;
    this.state.previewError = null;
    this.state.confirmPreview = null;
    this.state.confirmError = null;
    this.state.extractStagingDir = null;
    this.state.previewText = "Downloading tarball…";
    this.state.step = "preview";
    const loadId = ++this.loadId;
    this.renderBody();
    try {
      const blob = await ctx.api.downloadAppSnapshot(snapshot.id);
      if (loadId !== this.loadId) return;
      const dir = await mkdtemp(join(tmpdir(), "lamasync-dot-"));
      const tarPath = join(dir, `${snapshot.id}.tar.gz`);
      await mkdir(dir, { recursive: true });
      if (loadId !== this.loadId) return;
      await Bun.write(tarPath, blob);
      if (loadId !== this.loadId) return;
      const proc = Bun.spawn(["tar", "tzf", tarPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const text = await new Response(proc.stdout).text();
      const exit = await proc.exited;
      if (loadId !== this.loadId) return;
      if (exit !== 0) {
        const errText = await new Response(proc.stderr).text();
        this.state.previewError = `tar exited ${exit}: ${errText}`;
        this.state.previewText = "";
      } else {
        this.state.previewText = text.trim();
        // P-B item #15: cache the staging dir + tarball path so the
        // confirm-step diff preview (and the actual extract) can reuse
        // the download. Both halves read from this dir; the actual
        // extract overwrites files in the user's chosen target.
        this.state.extractStagingDir = tarPath;
      }
    } catch (err) {
      this.state.previewError =
        err instanceof Error ? err.message : String(err);
      this.state.previewText = "";
    }
    this.renderBody();
  }

  /**
   * Step-bound extract: invoked from the confirm step's Enter handler.
   * Parses the comma-separated subpaths from `state.extractSubpaths`, jumps
   * to the done step on success, and surfaces a copy-level error if the
   * user typed junk like an empty string. The actual tarball download +
   * spawn lives in `extractTarball` (LAMA-173 reviewer contract).
   */
  private async runConfirmedExtract(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const subpaths = this.state.extractSubpaths
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await this.extractTarball(
      this.state.protectionName ?? "",
      snapshot,
      this.state.extractTarget,
      subpaths,
    );
  }

  private async extractTarball(
    protectionName: string,
    snapshot: ApplicationSnapshot,
    target: string,
    subpaths: string[],
  ): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !protectionName) return;
    // LAMA-316 deliberately stops at inspection/download. Application data
    // needs a target-side setup plan, preflight, revalidation and rollback;
    // the old direct tar extraction cannot provide that safety contract.
    // Keep this method as a hard stop while its private callers are removed by
    // the setup-wizard delivery, so no hidden UI path can write to a target.
    if (!this.directRestoreAvailable()) {
      this.state.extractResult = "Direct app restoration is unavailable. Use the upcoming setup wizard to review a change plan first.";
      this.state.step = "preview";
      this.renderBody();
      return;
    }

    const loadId = ++this.loadId;
    if (!target) {
      this.state.extractResult = "Target directory required.";
      this.renderBody();
      return;
    }
    try {
      const blob = await ctx.api.downloadAppSnapshot(snapshot.id);
      if (this.loadId !== loadId) return;
      const stagingDir = await mkdtemp(join(tmpdir(), "lamasync-x-"));
      const tarPath = join(stagingDir, `${snapshot.id}.tar.gz`);
      await mkdir(target, { recursive: true });
      await Bun.write(tarPath, blob);
      if (this.loadId !== loadId) return;
      // Revalidate immediately before the write. The later migration wizard
      // will return a full target-side change plan; this bridge keeps the
      // existing local restore conservative by refusing to write when the
      // target can no longer be inspected.
      let preview;
      try {
        preview = await computeRestoreDiff(tarPath, target);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.state.extractResult = `Restore stopped before writing: unable to re-check ${target}: ${message}`;
        return;
      }
      if (this.loadId !== loadId) return;
      // Re-check the loadId BEFORE awaiting the spawn's stderr/exit; a stale
      // op hidden by Esc/hide must not overwrite current state.step.
      if (this.loadId !== loadId) return;
      const args = preservingExtractArgs(tarPath, target, subpaths);
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const errText = await new Response(proc.stderr).text();
      if (this.loadId !== loadId) return;
      const exit = await proc.exited;
      if (this.loadId !== loadId) return;
      if (exit !== 0) {
        this.state.extractResult = `tar failed (${exit}): ${errText}`;
      } else {
        const preserved = preview.counts.SAME + preview.counts.CHANGED;
        this.state.extractResult = `Restored ${preview.counts.NEW} missing file(s) to ${target}; preserved ${preserved} existing file(s)${
          subpaths.length ? ` (${subpaths.length} subpath(s))` : ""
        }.`;
        this.state.step = "done";
        // Best-effort restore tracking: record the restore in the operation
        // log so server UIs show app-restore activity.
        void ctx.api
          .reportOperation({
            hostId: ctx.hostname,
            operation: "app-restore",
            status: "success",
            summary: `restored ${protectionName} (${snapshot.id})`,
          })
          .catch(() => {});
      }
    } catch (err) {
      // Don't mutate state if we've been superseded (loadId advanced).
      if (this.loadId === loadId) {
        this.state.extractResult =
          err instanceof Error ? err.message : String(err);
      }
    }
    if (this.loadId === loadId) this.renderBody();
  }

  /** The setup-plan executor is intentionally not delivered yet. */
  private directRestoreAvailable(): boolean {
    return false;
  }

  // ---------------------------------------------------------------------------
  // Body rendering — replaces children of the inner Box; the outer container
  // is untouched so re-renders are cheap.
  // ---------------------------------------------------------------------------

  private renderBody(): void {
    // Blur the outgoing step's Input before swapping it out: removal does
    // not unsubscribe key handlers (OpenTUI 0.1.107 onRemove is a no-op),
    // so a detached Input would keep eating keys for the next step.
    this.activeInput?.blur?.();
    this.activeInput = null;
    const children: VNode[] = this.renderForStep();
    swapChildren(this.bodyBox, children);
    // Nothing auto-focuses newly-added renderables — the extract steps'
    // Input registered itself via mountStepInput; focus it now it's live.
    // (Cast: renderForStep re-assigns the field, which TS can't track past
    // the null assignment above.)
    (this.activeInput as { focus?: () => void } | null)?.focus?.();
  }

  /**
   * Build an extract-step Input as a REAL renderable with focus tracking.
   * Enter arrives as an "enter" event carrying the current text — the
   * `onSubmit` option is Textarea-only and never fires on Input (OpenTUI
   * 0.1.107), and a bare factory proxy's `input.value` reads break once
   * mounted, so handlers take the emitted value instead.
   */
  private mountStepInput(opts: {
    placeholder: string;
    value: string;
    onEnter: (value: string) => void;
  }): Renderable {
    const input = realize<Renderable>(
      this.renderer,
      Input({ placeholder: opts.placeholder }),
    ) as unknown as Renderable & {
      value: string;
      on: (event: string, handler: (...params: unknown[]) => void) => void;
      focus: () => void;
      blur: () => void;
    };
    input.value = opts.value;
    input.on("enter", (value: unknown) => opts.onEnter(String(value ?? "")));
    this.activeInput = input;
    return input;
  }

  private renderForStep(): VNode[] {
    switch (this.state.step) {
      case "app":
        return this.renderAppStep();
      case "snapshot":
        return this.renderSnapshotStep();
      case "preview":
        return this.renderPreviewStep();
      case "extract":
        return this.renderExtractStep();
      case "subpaths":
        return this.renderSubpathsStep();
      case "confirm":
        return this.renderConfirmStep();
      case "done":
        return this.renderDoneStep();
      case "setup":
        return this.renderSetupStep();
    }
  }

  /** Read-only fleet-wide backup-folder visibility block (LAMA-276). */
  private renderBackupFolders(): VNode[] {
    if (this.state.backupFolders.length === 0) return [];
    const lines: VNode[] = [
      Text({ content: `Backup folders (${this.state.backupFolders.length})` }),
    ];
    for (const b of this.state.backupFolders) {
      lines.push(Text({ content: `  ${b.name} — ${b.description}` }));
    }
    lines.push(Text({ content: "" }));
    return lines;
  }

  private renderAppStep(): VNode[] {
    const backups = this.renderBackupFolders();
    if (this.state.loadError) {
      return [
        Text({ content: `[!] ${this.state.loadError}` }),
        Text({ content: "Press Esc to return." }),
      ];
    }
    if (this.state.protections.length === 0) {
      return [
        ...backups,
        Text({ content: "Loading app protections…" }),
        Text({ content: "Press r to refresh." }),
      ];
    }
    const rows: AppRow[] = this.state.protections.map((p) => ({
      name: p.name,
      description: describeProtectionRow(p),
      value: p.id,
    }));
    const select = Select({
      options: rows,
      flexGrow: 1,
      selectedBackgroundColor: PALETTE_BG.accent,
      selectedTextColor: SELECTION.fg,
    });
    select.on("itemSelected", (_i: number, opt: AppRow) => {
      void this.selectProtection(opt.value);
    });
    return [
      ...backups,
      Text({ content: "App backups — app protections and snapshots" }),
      Text({
        content:
          "Select a protection to inspect its snapshots. Enroll protections on this host with the Web UI or `lamasync apps protections enroll`. Guided setup and recovery are coming separately.",
      }),
      Text({ content: "" }),
      select,
      Text({ content: "Press r to refresh." }),
    ];
  }

  private renderSnapshotStep(): VNode[] {
    if (this.state.snapshots.length === 0) {
      return [
        Text({ content: `Protection: ${this.state.protectionName ?? "?"}` }),
        Text({ content: "(no snapshots for this protection)" }),
        Text({ content: "Press Esc to return." }),
      ];
    }
    const rows: SnapshotRow[] = this.state.snapshots.map((s) => ({
      name: new Date(s.createdAt).toISOString(),
      description: s.description ? `${s.id} — ${s.description}` : s.id,
      value: s.id,
    }));
    const select = Select({
      options: rows,
      flexGrow: 1,
      selectedBackgroundColor: PALETTE_BG.accent,
      selectedTextColor: SELECTION.fg,
    });
    select.on("itemSelected", (_i: number, opt: SnapshotRow) => {
      const snapshot = this.state.snapshots.find((s) => s.id === opt.value);
      if (!snapshot) return;
      void this.selectSnapshot(snapshot);
    });
    return [
      Text({ content: `Protection: ${this.state.protectionName ?? "?"}` }),
      this.state.instructions
        ? Text({ content: `Instructions: ${formatMarkdownText(this.state.instructions, this.renderer?.width ?? 80)}` })
        : Text({ content: "" }),
      Text({ content: "" }),
      select,
      Text({ content: "Press Esc to go back." }),
    ];
  }

  private renderPreviewStep(): VNode[] {
    if (this.state.previewError) {
      return [
        Text({ content: `[!] ${this.state.previewError}` }),
        Text({ content: "Press Esc to go back." }),
      ];
    }
    const previewNodes: VNode[] = [];
    if (this.markdownCtx) {
      try {
        const md = new MarkdownRenderable(this.markdownCtx, {
          content: "```\n" + (this.state.previewText || "(empty tarball)") + "\n```",
          syntaxStyle: this.syntaxStyle,
        });
        previewNodes.push(md as unknown as VNode);
      } catch {
        previewNodes.push(Text({ content: this.state.previewText || "(empty tarball)" }));
      }
    } else {
      previewNodes.push(Text({ content: this.state.previewText || "(empty tarball)" }));
    }
    return [
      Text({ content: `Preview: ${this.state.snapshot?.id ?? "?"}` }),
      this.state.instructions
        ? Text({ content: `Instructions: ${formatMarkdownText(this.state.instructions, this.renderer?.width ?? 80)}` })
        : Text({ content: "" }),
      Text({ content: "Inspect-only: direct extraction is disabled until the guided setup plan is available. Press Esc to go back." }),
      ...previewNodes,
    ];
  }

  private renderExtractStep(): VNode[] {
    const input = this.mountStepInput({
      placeholder: "Target directory (absolute path)",
      value: this.state.extractTarget,
      onEnter: (value) => {
        if (!this.state.snapshot) return;
        this.state.extractTarget = value;
        this.state.step = "subpaths";
        this.renderBody();
      },
    });
    return [
      Text({ content: `Extract: ${this.state.snapshot?.id ?? "?"}` }),
      Text({
        content:
          "Enter target directory and press Enter. Use / to restore to original absolute paths.",
      }),
      Text({ content: "Press Esc to cancel." }),
      input as unknown as VNode,
    ];
  }

  private renderSubpathsStep(): VNode[] {
    const input = this.mountStepInput({
      placeholder: "Subpaths to extract, comma-separated (empty = all)",
      value: this.state.extractSubpaths,
      onEnter: (value) => {
        if (!this.state.snapshot) return;
        this.state.extractSubpaths = value;
        // P-B item #15: instead of extracting immediately, jump to the
        // confirm step where the user sees what restore would change.
        // `runConfirmStep` computes the diff against the chosen target +
        // subpaths filter and transitions to "confirm" (or — when the
        // download failed and there's no tarball to diff against —
        // bounces back to the snapshot picker).
        void this.runConfirmStep();
      },
    });
    return [
      Text({ content: `Extract to: ${this.state.extractTarget}` }),
      Text({ content: `Snapshot: ${this.state.snapshot?.id ?? "?"}` }),
      Text({
        content:
          "Enter subpaths (e.g. agents/,settings.json) or leave empty for all.",
      }),
      Text({ content: "Press Esc to cancel." }),
      input as unknown as VNode,
    ];
  }

  // ---------------------------------------------------------------------------
  // Confirm-step diff preview (P-B item #15).
  //
  // Runs the tarball listing against the chosen target directory and
  // renders a short NEW / CHANGED / SAME summary. The user must press
  // Enter to actually extract; Esc steps back to the subpaths step. This
  // is the wired-up "where confirmation currently happens" gesture per the
  // polish brief — focused widget (the body Text) owns Enter, Esc cancels
  // via the standard STEP_BACK transition.
  // ---------------------------------------------------------------------------

  private async runConfirmStep(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const snapshot = this.state.snapshot;
    const tarball = this.state.extractStagingDir;
    if (!snapshot || !tarball) {
      // Missing staging dir = tar download failed earlier; bounce back so
      // the user can pick a different snapshot.
      this.state.confirmError = "tarball preview not available — return to the snapshot list.";
      this.state.step = "snapshot";
      this.renderBody();
      return;
    }
    this.state.confirmPreview = "Computing diff against disk…";
    this.state.confirmError = null;
    this.state.step = "confirm";
    const loadId = ++this.loadId;
    this.renderBody();
    try {
      const result = await computeRestoreDiff(
        tarball,
        this.state.extractTarget,
      );
      if (this.loadId !== loadId) return;
      this.state.confirmPreview = formatDiffPreview(result);
    } catch (err) {
      if (this.loadId !== loadId) return;
      this.state.confirmError =
        err instanceof Error ? err.message : String(err);
      this.state.confirmPreview = null;
    }
    this.renderBody();
  }

  private renderConfirmStep(): VNode[] {
    if (this.state.confirmError) {
      return [
        Text({ content: `Confirm: ${this.state.snapshot?.id ?? "?"}` }),
        Text({ content: `[!] ${this.state.confirmError}` }),
        Text({ content: "Press Esc to step back." }),
      ];
    }
    const preview = this.state.confirmPreview ?? "(no preview)";
    return [
      Text({
        content: `Confirm restore: ${this.state.snapshot?.id ?? "?"} → ${this.state.extractTarget}`,
      }),
      Text({
        content:
          "Press Enter to restore missing files only. Existing target files are preserved; guided replace is coming soon. Esc cancels.",
      }),
      Text({ content: "" }),
      Text({ content: preview }),
    ];
  }

  private renderDoneStep(): VNode[] {
    return [
      Text({ content: this.state.extractResult ?? "Done." }),
      Text({ content: "Press Enter to return to the protection list, Esc to step back." }),
    ];
  }

  private renderSetupStep(): VNode[] {
    return [
      ...this.renderBackupFolders(),
      Text({ content: "Fresh-install setup" }),
      Text({ content: this.state.extractResult ?? "Working…" }),
      Text({ content: "Press r to refresh." }),
      hotkeyFooter(this.hotkeys().map((h) => ({ key: h.key, label: h.label }))),
    ];
  }

  /** Public state accessor for the back-compat controller factory. */
  publicState(): DotfilesState {
    return this.state;
  }
}



/**
 * Back-compat factory preserved per LAMA-173 review (TuiDotfilesGh
 * .ReviewDotfilesGh, round 4). External harnesses and legacy test
 * scaffolds may still import `renderDotfiles`; slice J's boot.ts does
 * NOT depend on this — only the View class is wired through the Shell.
 *
 * The factory builds a stub ViewContext and immediately calls
 * view.onShow() so the controller has an active API (refresh runs from
 * onShow). onAction is forwarded verbatim so legacy Escape/Enter code
 * paths that route through the controller keep working.
 */
export function renderDotfiles(
  opts: RenderDotfilesOpts,
): DotfilesController {
  const stubCtx: ViewContext = {
    api: opts.api,
    hostname: opts.currentHostId,
    socketPath: process.env.LAMASYNC_SOCKET_PATH ?? "",
    renderer: null,
    setStatus: () => undefined,
    openWizard: () => undefined,
  };
  const view = new DotfilesView({ ctx: stubCtx });
  view.onShow(stubCtx);
  return {
    view: view.container as unknown as VNode,
    handleKey: (e: KeyEvent) => {
      view.handleKey(e);
    },
    state: view.publicState(),
    onAction: opts.onAction,
  };
}
