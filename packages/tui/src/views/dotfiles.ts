import {
  Box,
  Input,
  MarkdownRenderable,
  Select,
  SyntaxStyle,
  Text,
} from "@opentui/core";
import type { KeyEvent, RenderContext, VNode } from "@opentui/core";
import { mkdir, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import type { DotfileManifest, DotfileVersion, LamaSyncApiClient } from "@lamasync/core";

export type DotfilesAction = "menu" | "quit";

export interface RenderDotfilesOpts {
  api: LamaSyncApiClient;
  currentHostId: string;
  ctx: RenderContext;
  onAction: (action: DotfilesAction) => void;
}

export interface DotfilesController {
  view: VNode;
  handleKey: (e: KeyEvent) => void;
  state: DotfilesState;
}

type Step = "app" | "version" | "preview" | "extract" | "subpaths" | "done" | "setup";

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

interface VersionRow {
  name: string;
  description: string;
  value: string;
}

interface AppRow {
  name: string;
  description: string;
  value: string;
}

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

export function renderDotfiles(opts: RenderDotfilesOpts): DotfilesController {
  const state: DotfilesState = {
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
  const syntaxStyle = SyntaxStyle.create();

  const controller: DotfilesController = {
    view: renderView(state, opts, syntaxStyle),
    handleKey: () => undefined,
    state,
  };

  controller.handleKey = (e: KeyEvent) =>
    handleKey(e, state, controller, opts, syntaxStyle);

  void loadApps(controller, opts, syntaxStyle);
  return controller;
}

function manifestForApp(state: DotfilesState, appName: string): DotfileManifest | undefined {
  return state.manifests.find((m) => m.appName === appName);
}

async function loadApps(
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  try {
    controller.state.manifests = await opts.api.listDotfileManifests(opts.currentHostId);
    const seen = new Set<string>();
    for (const m of controller.state.manifests) seen.add(m.appName);
    controller.state.apps = [...seen].sort();
    controller.state.loadError = null;
  } catch (err) {
    controller.state.loadError = err instanceof Error ? err.message : String(err);
  }
  controller.view = renderView(controller.state, opts, syntaxStyle);
}

async function loadVersions(
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  appName: string,
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  controller.state.appName = appName;
  controller.state.instructions = manifestForApp(controller.state, appName)?.instructions ?? null;
  try {
    controller.state.versions = await opts.api.listDotfileVersions(appName);
    controller.state.loadError = null;
  } catch (err) {
    controller.state.versions = [];
    controller.state.loadError = err instanceof Error ? err.message : String(err);
  }
  controller.view = renderView(controller.state, opts, syntaxStyle);
}

async function downloadAndPreview(
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  version: DotfileVersion,
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  controller.state.version = version;
  controller.state.previewError = null;
  controller.state.previewText = "Downloading tarball…";
  controller.view = renderView(controller.state, opts, syntaxStyle);

  const appName = controller.state.appName;
  if (!appName) {
    controller.state.previewError = "No app selected";
    controller.view = renderView(controller.state, opts, syntaxStyle);
    return;
  }

  try {
    const blob = await opts.api.downloadDotfile(appName, version.id);
    const dir = await mkdtemp(join(tmpdir(), "lamasync-dot-"));
    const tarPath = join(dir, `${version.id}.tar.gz`);
    await mkdir(dir, { recursive: true });
    await Bun.write(tarPath, blob);
    const proc = Bun.spawn(["tar", "tzf", tarPath], { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      const errText = await new Response(proc.stderr).text();
      controller.state.previewError = `tar exited ${exit}: ${errText}`;
      controller.state.previewText = "";
    } else {
      controller.state.previewText = text.trim();
      controller.state.step = "preview";
    }
  } catch (err) {
    controller.state.previewError = err instanceof Error ? err.message : String(err);
    controller.state.previewText = "";
  }
  controller.view = renderView(controller.state, opts, syntaxStyle);
}

async function extractTarball(
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  version: DotfileVersion,
  target: string,
  subpaths: string[],
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  if (!target) {
    controller.state.extractResult = "Target directory required.";
    controller.view = renderView(controller.state, opts, syntaxStyle);
    return;
  }
  const appName = controller.state.appName;
  if (!appName) {
    controller.state.extractResult = "No app selected.";
    controller.view = renderView(controller.state, opts, syntaxStyle);
    return;
  }
  try {
    const blob = await opts.api.downloadDotfile(appName, version.id);
    const stagingDir = await mkdtemp(join(tmpdir(), "lamasync-x-"));
    const tarPath = join(stagingDir, `${version.id}.tar.gz`);
    await mkdir(target, { recursive: true });
    await Bun.write(tarPath, blob);
    const args = ["tar", "xzf", tarPath, "-C", target];
    if (subpaths.length > 0) args.push(...subpaths);
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const errText = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      controller.state.extractResult = `tar failed (${exit}): ${errText}`;
    } else {
      controller.state.extractResult = `Extracted to ${target}${subpaths.length ? ` (${subpaths.length} subpath(s))` : ""}`;
      controller.state.step = "done";
    }
  } catch (err) {
    controller.state.extractResult = err instanceof Error ? err.message : String(err);
  }
  controller.view = renderView(controller.state, opts, syntaxStyle);
}

async function restoreAllLatest(
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  controller.state.step = "setup";
  controller.state.extractResult = "Restoring latest versions of all apps…";
  controller.view = renderView(controller.state, opts, syntaxStyle);

  const results: string[] = [];
  for (const appName of controller.state.apps) {
    try {
      const versions = await opts.api.listDotfileVersions(appName);
      const latest = versions[0];
      if (!latest) {
        results.push(`${appName}: no versions`);
        continue;
      }
      await extractTarball(controller, opts, latest, "/", [], syntaxStyle);
      results.push(`${appName}: restored latest (${latest.id})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${appName}: failed — ${msg}`);
    }
  }
  controller.state.extractResult = results.join("\n");
  controller.view = renderView(controller.state, opts, syntaxStyle);
}

function handleKey(
  e: KeyEvent,
  state: DotfilesState,
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
): void {
  const name = (e.name ?? "").toLowerCase();
  if (name === "escape") {
    if (state.step === "app") {
      opts.onAction("menu");
      return;
    }
    state.step = STEP_BACK[state.step];
    controller.view = renderView(state, opts, syntaxStyle);
    return;
  }
  if (name === "return" || name === "enter") {
    if (state.step === "preview") {
      state.step = "extract";
      controller.view = renderView(state, opts, syntaxStyle);
      return;
    }
    if (state.step === "done") {
      opts.onAction("menu");
      return;
    }
  }
}

function renderView(
  state: DotfilesState,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
): VNode {
  const header = Text({ content: "Dotfiles" });
  switch (state.step) {
    case "app":
      return renderAppStep(state, opts, syntaxStyle, header);
    case "version":
      return renderVersionStep(state, opts, syntaxStyle, header);
    case "preview":
      return renderPreviewStep(state, opts, syntaxStyle, header);
    case "extract":
      return renderExtractStep(state, opts, syntaxStyle, header);
    case "subpaths":
      return renderSubpathsStep(state, opts, syntaxStyle, header);
    case "done":
      return renderDoneStep(header, state);
    case "setup":
      return renderSetupStep(header, state);
  }
}

function renderAppStep(
  state: DotfilesState,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
  header: VNode,
): VNode {
  if (state.loadError) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: `Error: ${state.loadError}` }),
      Text({ content: "Press Esc to return to menu." }),
    );
  }
  if (state.apps.length === 0) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: "Loading apps…" }),
      Text({ content: "Press Esc to return to menu." }),
    );
  }
  const rows: AppRow[] = [
    { name: "🔄 Setup (restore all apps)", description: "fresh-install restore", value: SETUP_KEY },
    ...state.apps.map((name) => ({
      name,
      description: manifestForApp(state, name)?.instructions ?? "dotfile snapshots",
      value: name,
    })),
  ];
  const select = Select({ options: rows, flexGrow: 1 });
  select.on("itemSelected", (_i: number, opt: AppRow) => {
    if (opt.value === SETUP_KEY) {
      const ctl: DotfilesController = {
        view: renderView(state, opts, syntaxStyle),
        handleKey: () => undefined,
        state,
      };
      void restoreAllLatest(ctl, opts, syntaxStyle);
      return;
    }
    state.appName = opt.value;
    state.step = "version";
    const ctl: DotfilesController = {
      view: renderView(state, opts, syntaxStyle),
      handleKey: () => undefined,
      state,
    };
    void loadVersions(ctl, opts, opt.value, syntaxStyle);
  });
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: "Select an app to browse its snapshots, or choose Setup." }),
    Text({ content: "" }),
    select,
    Text({ content: "Press Esc to return." }),
  );
}

function renderVersionStep(
  state: DotfilesState,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
  header: VNode,
): VNode {
  if (state.versions.length === 0) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: `App: ${state.appName ?? "?"}` }),
      Text({ content: "(no versions for this app)" }),
      Text({ content: "Press Esc to return." }),
    );
  }
  const rows: VersionRow[] = state.versions.map((v) => ({
    name: new Date(v.timestamp).toISOString(),
    description: v.description ? `${v.id} — ${v.description}` : v.id,
    value: v.id,
  }));
  const select = Select({ options: rows, flexGrow: 1 });
  select.on("itemSelected", (_i: number, opt: VersionRow) => {
    const version = state.versions.find((v) => v.id === opt.value);
    if (!version) return;
    const ctl: DotfilesController = {
      view: renderView(state, opts, syntaxStyle),
      handleKey: () => undefined,
      state,
    };
    void downloadAndPreview(ctl, opts, version, syntaxStyle);
  });
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `App: ${state.appName ?? "?"}` }),
    state.instructions
      ? Text({ content: `Instructions: ${state.instructions}` })
      : Text({ content: "" }),
    Text({ content: "" }),
    select,
    Text({ content: "Press Esc to go back." }),
  );
}

function renderPreviewStep(
  state: DotfilesState,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
  header: VNode,
): VNode {
  if (state.previewError) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: `Error: ${state.previewError}` }),
      Text({ content: "Press Esc to go back." }),
    );
  }
  const md = new MarkdownRenderable(opts.ctx, {
    content: "```\n" + (state.previewText || "(empty tarball)") + "\n```",
    syntaxStyle,
  });
  const instructions = state.instructions
    ? Text({ content: `Instructions: ${state.instructions}` })
    : Text({ content: "" });
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `Preview: ${state.version?.id ?? "?"}` }),
    instructions,
    Text({ content: "Press Enter to extract, Esc to go back." }),
    md,
  );
}

function renderExtractStep(
  state: DotfilesState,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
  header: VNode,
): VNode {
  const input = Input({
    placeholder: "Target directory (absolute path)",
    value: state.extractTarget,
    onSubmit: () => {
      if (!state.version) return;
      state.extractTarget = input.value;
      state.step = "subpaths";
      const ctl: DotfilesController = {
        view: renderView(state, opts, syntaxStyle),
        handleKey: () => undefined,
        state,
      };
      ctl.view = renderView(state, opts, syntaxStyle);
    },
  });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `Extract: ${state.version?.id ?? "?"}` }),
    Text({ content: "Enter target directory and press Enter. Use / to restore to original absolute paths." }),
    Text({ content: "Press Esc to cancel." }),
    input,
  );
}

function renderSubpathsStep(
  state: DotfilesState,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
  header: VNode,
): VNode {
  const input = Input({
    placeholder: "Subpaths to extract, comma-separated (empty = all)",
    value: state.extractSubpaths,
    onSubmit: () => {
      if (!state.version) return;
      state.extractSubpaths = input.value;
      const subpaths = input.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const ctl: DotfilesController = {
        view: renderView(state, opts, syntaxStyle),
        handleKey: () => undefined,
        state,
      };
      void extractTarball(ctl, opts, state.version, state.extractTarget, subpaths, syntaxStyle);
    },
  });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `Extract to: ${state.extractTarget}` }),
    Text({ content: `Version: ${state.version?.id ?? "?"}` }),
    Text({ content: "Enter subpaths (e.g. agents/,settings.json) or leave empty for all." }),
    Text({ content: "Press Esc to cancel." }),
    input,
  );
}

function renderDoneStep(header: VNode, state: DotfilesState): VNode {
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: state.extractResult ?? "Done." }),
    Text({ content: "Press Enter to return to menu, Esc to step back." }),
  );
}

function renderSetupStep(header: VNode, state: DotfilesState): VNode {
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: "Fresh-install setup" }),
    Text({ content: state.extractResult ?? "Working…" }),
    Text({ content: "Press Enter to return to menu, Esc to step back." }),
  );
}
