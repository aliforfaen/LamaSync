// Dotfiles view: lists manifests from the server, browses versions, and lets
// the user restore a tarball. Implements the foundation `View` contract — the
// outer container is built once in the constructor; per-step refreshes mutate
// only the body Box (cheap). The legacy `DotfilesController` /
// `RenderDotfilesOpts` types remain exported as a back-compat surface, but
// the runtime `renderDotfiles` factory was removed in the LAMA-173 review
// passes — the only caller was the now-retired `packages/tui/src/index.ts`
// shell entry, and the View contract drives the new boot path.

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
  KeyEvent,
  Renderable,
  RenderContext,
  VNode,
} from "@opentui/core";
import { mkdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type {
  DotfileManifest,
  DotfileVersion,
  LamaSyncApiClient,
} from "@lamasync/core";

import { hotkeyFooter, pageShell, realize, swapChildren } from "../app/widgets.ts";
import type { Hotkey } from "../app/keymap.ts";
import { matchHotkey } from "../app/keymap.ts";
import type {
  View,
  ViewContext,
  ViewId,
} from "../app/view-manager.ts";
import { createDotfileManifestWizard } from "../flows/dotfile-manifest.ts";

// -----------------------------------------------------------------------------
// Public types — kept stable for any consumer still importing the pre-slice
// names. The action surface narrows to the gestures the new View exposes:
// refresh, open the manifest wizard, and back to the previous step.
// -----------------------------------------------------------------------------

export type DotfilesAction = "refresh" | "manifest" | "menu" | "quit" | "back";

type Step =
  | "app"
  | "version"
  | "preview"
  | "extract"
  | "subpaths"
  | "done"
  | "setup";

export interface DotfilesState {
  step: Step;
  manifests: DotfileManifest[];
  apps: string[];
  appName: string | null;
  instructions: string | null;
  versions: DotfileVersion[];
  version: DotfileVersion | null;
  previewText: string;
  previewError: string | null;
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
  version: "app",
  preview: "version",
  extract: "preview",
  subpaths: "extract",
  done: "app",
  setup: "app",
};

const SETUP_KEY = "__setup__";

/** App-list row description: instructions plus deployment info (LAMA-168). */
function describeManifestRow(manifest: DotfileManifest | undefined): string {
  if (!manifest) return "dotfile snapshots";
  const parts: string[] = [manifest.instructions ?? "dotfile snapshots"];
  if (manifest.lastSyncAt) {
    const when = new Date(manifest.lastSyncAt).toLocaleString();
    parts.push(`last ${manifest.lastSyncDirection ?? "sync"}: ${when}`);
  }
  return parts.join(" — ");
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

interface AppRow {
  name: string;
  description: string;
  value: string;
}

interface VersionRow {
  name: string;
  description: string;
  value: string;
}

/**
 * Dotfiles browser + restore view. Implements the foundation `View` contract.
 * The container is built once in the constructor; per-step refreshes swap the
 * body Box's children. The Enter key advances within the state machine; the
 * Shell dispatches `r` / `n` / number keys through the hotkey table.
 */
export class DotfilesView implements View {
  static readonly id: ViewId = "dotfiles";
  static readonly title = "Dotfiles";

  readonly id: ViewId = DotfilesView.id;
  readonly title: string = DotfilesView.title;

  private readonly bodyBox: BoxRenderable;
  private readonly syntaxStyle: SyntaxStyle;
  private readonly markdownCtx: RenderContext | null;

  private readonly state: DotfilesState = {
    step: "app",
    manifests: [],
    apps: [],
    appName: null,
    instructions: null,
    versions: [],
    version: null,
    previewText: "",
    previewError: null,
    extractTarget: "/",
    extractSubpaths: "",
    extractResult: null,
    loadError: null,
  };

  private ctx: ViewContext | null = null;
  private loadId = 0;
  private rootCtx: RenderContext | null = null;

  readonly container: Renderable;


  constructor(opts: { ctx: ViewContext; rootCtx?: RenderContext }) {
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
        "Dotfiles",
        Box({ flexDirection: "column", flexGrow: 1 }, this.bodyBox),
      ),
    );
    // Defer first paint to onShow(): the manifest list comes from the API,
    // so there is nothing meaningful to render before then.
  }

  // ---------------------------------------------------------------------------
  // Hotkeys — refresh, open the manifest wizard.
  // ---------------------------------------------------------------------------

  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "r", label: "refresh", run: () => void this.refresh() },
      {
        key: "n",
        label: "new manifest…",
        run: () => this.openManifestWizard(),
      },
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
    this.restoreAllInProgress = false;
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
        this.state.step = "extract";
        this.renderBody();
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
      const manifests = await ctx.api.listDotfileManifests(ctx.hostname);
      if (loadId !== this.loadId) return;
      const seen = new Set<string>();
      for (const m of manifests) seen.add(m.appName);
      this.state.manifests = manifests;
      this.state.apps = [...seen].sort();
      this.state.loadError = null;
      // If the user has no manifests, route to the setup step so the body
      // explains how to bootstrap. The user can press r again once a
      // manifest exists to return to the app picker.
      if (this.state.apps.length === 0 && this.state.step === "app") {
        this.state.step = "setup";
        this.state.extractResult =
          "No dotfile manifests yet — press n to create one, or run a sync on a dotfile folder.";
      }
      // P1 (TuiDotfilesGh.ReviewDotfilesGh): if we were stuck on setup
      // because manifests were empty, but a new refresh now surfaces some,
      // drop back to the app picker so the user can actually pick one.
      if (this.state.apps.length > 0 && this.state.step === "setup") {
        this.state.step = "app";
        this.state.extractResult = null;
      }
    } catch (err) {
      if (loadId !== this.loadId) return;
      this.state.loadError =
        err instanceof Error ? err.message : String(err);
      this.state.manifests = [];
      this.state.apps = [];
    }
    this.renderBody();
  }

  private async selectApp(appName: string): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const loadId = ++this.loadId;
    this.state.appName = appName;
    const manifest = this.state.manifests.find((m) => m.appName === appName);
    this.state.instructions = manifest?.instructions ?? null;
    try {
      const versions = await ctx.api.listDotfileVersions(appName);
      if (loadId !== this.loadId) return;
      this.state.versions = versions;
      this.state.step = "version";
    } catch (err) {
      if (loadId !== this.loadId) return;
      this.state.versions = [];
      this.state.loadError =
        err instanceof Error ? err.message : String(err);
    }
    this.renderBody();
  }

  private async selectVersion(version: DotfileVersion): Promise<void> {
    const ctx = this.ctx;
    const appName = this.state.appName;
    if (!ctx || !appName) return;
    this.state.version = version;
    this.state.previewError = null;
    this.state.previewText = "Downloading tarball…";
    this.state.step = "preview";
    const loadId = ++this.loadId;
    this.renderBody();
    try {
      const blob = await ctx.api.downloadDotfile(appName, version.id);
      if (loadId !== this.loadId) return;
      const dir = await mkdtemp(join(tmpdir(), "lamasync-dot-"));
      const tarPath = join(dir, `${version.id}.tar.gz`);
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
      }
    } catch (err) {
      this.state.previewError =
        err instanceof Error ? err.message : String(err);
      this.state.previewText = "";
    }
    this.renderBody();
  }

  private restoreAllInProgress = false;

  private async runRestoreAllLatest(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.restoreAllInProgress) return;
    this.restoreAllInProgress = true;
    const loadId = ++this.loadId;
    this.state.step = "setup";
    this.state.extractResult = "Restoring latest versions of all apps…";
    this.renderBody();

    const results: string[] = [];
    let bailed = false;
    for (const appName of this.state.apps) {
      if (loadId !== this.loadId) { bailed = true; break; }
      try {
        const versions = await ctx.api.listDotfileVersions(appName);
        if (loadId !== this.loadId) { bailed = true; break; }
        const latest = versions[0];
        if (!latest) {
          results.push(`${appName}: no versions`);
          continue;
        }
        await this.extractTarball(appName, latest, "/", [], { fromRestoreAll: true, externalLoadId: loadId });
        if (loadId !== this.loadId) { bailed = true; break; }
        results.push(`${appName}: restored latest (${latest.id})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${appName}: failed — ${msg}`);
      }
    }
    this.restoreAllInProgress = false;
    if (bailed) {
      // Outer loop superseded: leave room for the next run by stamping a
      // fresh loadId so a subsequent manual refresh / restore attempt
      // doesn't get stuck behind a stale guard.
      this.loadId++;
      this.renderBody();
      return;
    }
    this.state.extractResult = results.join("\n");
    this.renderBody();
  }

  private async extractTarball(
    appName: string,
    version: DotfileVersion,
    target: string,
    subpaths: string[],
    opts?: { fromRestoreAll?: boolean; externalLoadId?: number },
  ): Promise<void> {
    const ctx = this.ctx;
    // Honour an outer loop's loadId (runRestoreAllLatest) so per-app
    // increments don't trip the outer guard. Otherwise increment locally.
    // P1 fix (TuiDotfilesGh.ReviewDotfilesGh, round 4): the inner
    // ++this.loadId used to invalidate the outer loop's loadId check
    // after the first app, leaving restoreAllInProgress=true.
    const loadId =
      opts?.externalLoadId !== undefined ? opts.externalLoadId : ++this.loadId;
    if (!ctx || !appName) return;
    if (!target) {
      this.state.extractResult = "Target directory required.";
      this.renderBody();
      return;
    }
    try {
      const blob = await ctx.api.downloadDotfile(appName, version.id);
      if (this.loadId !== loadId) return;
      const stagingDir = await mkdtemp(join(tmpdir(), "lamasync-x-"));
      const tarPath = join(stagingDir, `${version.id}.tar.gz`);
      await mkdir(target, { recursive: true });
      await Bun.write(tarPath, blob);
      if (this.loadId !== loadId) return;
      // Re-check the loadId BEFORE awaiting the spawn's stderr/exit; a stale
      // op hidden by Esc/hide must not overwrite current state.step.
      if (this.loadId !== loadId) return;
      const args = ["tar", "xzf", tarPath, "-C", target];
      if (subpaths.length > 0) args.push(...subpaths);
      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const errText = await new Response(proc.stderr).text();
      if (this.loadId !== loadId) return;
      const exit = await proc.exited;
      if (this.loadId !== loadId) return;
      if (exit !== 0) {
        this.state.extractResult = `tar failed (${exit}): ${errText}`;
      } else {
        this.state.extractResult = `Extracted to ${target}${
          subpaths.length ? ` (${subpaths.length} subpath(s))` : ""
        }`;
        if (!opts?.fromRestoreAll) this.state.step = "done";
        // Best-effort deployment tracking (LAMA-168): record the download on
        // the manifest so last-sync/direction show up in server UIs.
        void ctx.api
          .reportOperation({
            hostId: ctx.hostname,
            operation: "dotfile-restore",
            status: "success",
            summary: `restored ${appName} (${version.id})`,
            dotfileAppName: appName,
            dotfileDirection: "download",
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

  private openManifestWizard(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    ctx.openWizard(createDotfileManifestWizard({ ctx }));
  }

  // ---------------------------------------------------------------------------
  // Body rendering — replaces children of the inner Box; the outer container
  // is untouched so re-renders are cheap.
  // ---------------------------------------------------------------------------

  private renderBody(): void {
    const children: VNode[] = this.renderForStep();
    swapChildren(this.bodyBox, children);
  }

  private renderForStep(): VNode[] {
    switch (this.state.step) {
      case "app":
        return this.renderAppStep();
      case "version":
        return this.renderVersionStep();
      case "preview":
        return this.renderPreviewStep();
      case "extract":
        return this.renderExtractStep();
      case "subpaths":
        return this.renderSubpathsStep();
      case "done":
        return this.renderDoneStep();
      case "setup":
        return this.renderSetupStep();
    }
  }

  private renderAppStep(): VNode[] {
    if (this.state.loadError) {
      return [
        Text({ content: `[!] ${this.state.loadError}` }),
        Text({ content: "Press Esc to return." }),
      ];
    }
    if (this.state.apps.length === 0) {
      return [
        Text({ content: "Loading apps…" }),
        Text({ content: "Press n to create a manifest, r to refresh." }),
      ];
    }
    const rows: AppRow[] = [
      {
        name: "🔄 Setup (restore all apps)",
        description: "fresh-install restore",
        value: SETUP_KEY,
      },
      ...this.state.apps.map((name) => {
        const manifest = this.state.manifests.find(
          (m) => m.appName === name,
        );
        return {
          name,
          description: describeManifestRow(manifest),
          value: name,
        };
      }),
    ];
    const select = Select({ options: rows, flexGrow: 1 });
    select.on("itemSelected", (_i: number, opt: AppRow) => {
      if (opt.value === SETUP_KEY) {
        void this.runRestoreAllLatest();
        return;
      }
      void this.selectApp(opt.value);
    });
    return [
      Text({ content: "Select an app to browse its snapshots, or choose Setup." }),
      Text({ content: "" }),
      select,
      Text({ content: "Press r to refresh, n for new manifest." }),
    ];
  }

  private renderVersionStep(): VNode[] {
    if (this.state.versions.length === 0) {
      return [
        Text({ content: `App: ${this.state.appName ?? "?"}` }),
        Text({ content: "(no versions for this app)" }),
        Text({ content: "Press Esc to return." }),
      ];
    }
    const rows: VersionRow[] = this.state.versions.map((v) => ({
      name: new Date(v.timestamp).toISOString(),
      description: v.description ? `${v.id} — ${v.description}` : v.id,
      value: v.id,
    }));
    const select = Select({ options: rows, flexGrow: 1 });
    select.on("itemSelected", (_i: number, opt: VersionRow) => {
      const version = this.state.versions.find((v) => v.id === opt.value);
      if (!version) return;
      void this.selectVersion(version);
    });
    return [
      Text({ content: `App: ${this.state.appName ?? "?"}` }),
      this.state.instructions
        ? Text({ content: `Instructions: ${this.state.instructions}` })
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
      Text({ content: `Preview: ${this.state.version?.id ?? "?"}` }),
      this.state.instructions
        ? Text({ content: `Instructions: ${this.state.instructions}` })
        : Text({ content: "" }),
      Text({ content: "Press Enter to extract, Esc to go back." }),
      ...previewNodes,
    ];
  }

  private renderExtractStep(): VNode[] {
    const input = Input({
      placeholder: "Target directory (absolute path)",
      value: this.state.extractTarget,
      onSubmit: () => {
        if (!this.state.version) return;
        this.state.extractTarget = input.value;
        this.state.step = "subpaths";
        this.renderBody();
      },
    });
    return [
      Text({ content: `Extract: ${this.state.version?.id ?? "?"}` }),
      Text({
        content:
          "Enter target directory and press Enter. Use / to restore to original absolute paths.",
      }),
      Text({ content: "Press Esc to cancel." }),
      input,
    ];
  }

  private renderSubpathsStep(): VNode[] {
    const input = Input({
      placeholder: "Subpaths to extract, comma-separated (empty = all)",
      value: this.state.extractSubpaths,
      onSubmit: () => {
        if (!this.state.version) return;
        this.state.extractSubpaths = input.value;
        const subpaths = input.value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        void this.extractTarball(
          this.state.appName ?? "",
          this.state.version,
          this.state.extractTarget,
          subpaths,
        );
      },
    });
    return [
      Text({ content: `Extract to: ${this.state.extractTarget}` }),
      Text({ content: `Version: ${this.state.version?.id ?? "?"}` }),
      Text({
        content:
          "Enter subpaths (e.g. agents/,settings.json) or leave empty for all.",
      }),
      Text({ content: "Press Esc to cancel." }),
      input,
    ];
  }

  private renderDoneStep(): VNode[] {
    return [
      Text({ content: this.state.extractResult ?? "Done." }),
      Text({ content: "Press Enter to return to app list, Esc to step back." }),
    ];
  }

  private renderSetupStep(): VNode[] {
    return [
      Text({ content: "Fresh-install setup" }),
      Text({ content: this.state.extractResult ?? "Working…" }),
      Text({ content: "Press n to add a manifest, r to refresh." }),
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
