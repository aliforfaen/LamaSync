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

import type { DotfileVersion, LamaSyncApiClient } from "@lamasync/core";

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

type Step = "app" | "version" | "preview" | "extract" | "done";

export interface DotfilesState {
  step: Step;
  apps: string[];
  appName: string | null;
  versions: DotfileVersion[];
  version: DotfileVersion | null;
  previewText: string;
  previewError: string | null;
  extractTarget: string;
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
  done: "app",
};

export function renderDotfiles(opts: RenderDotfilesOpts): DotfilesController {
  const state: DotfilesState = {
    step: "app",
    apps: [],
    appName: null,
    versions: [],
    version: null,
    previewText: "",
    previewError: null,
    extractTarget: "",
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

async function loadApps(
  controller: DotfilesController,
  opts: RenderDotfilesOpts,
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  try {
    const versions = await opts.api.listDotfilesForHost(opts.currentHostId);
    const seen = new Set<string>();
    for (const v of versions) seen.add(v.manifestId);
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

  try {
    const blob = await opts.api.downloadDotfile(version.manifestId, version.id);
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
  syntaxStyle: SyntaxStyle,
): Promise<void> {
  if (!target) {
    controller.state.extractResult = "Target directory required.";
    controller.view = renderView(controller.state, opts, syntaxStyle);
    return;
  }
  try {
    const blob = await opts.api.downloadDotfile(version.manifestId, version.id);
    const stagingDir = await mkdtemp(join(tmpdir(), "lamasync-x-"));
    const tarPath = join(stagingDir, `${version.id}.tar.gz`);
    await mkdir(target, { recursive: true });
    await Bun.write(tarPath, blob);
    const proc = Bun.spawn(["tar", "xzf", tarPath, "-C", target], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const errText = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      controller.state.extractResult = `tar failed (${exit}): ${errText}`;
    } else {
      controller.state.extractResult = `Extracted to ${target}`;
      controller.state.step = "done";
    }
  } catch (err) {
    controller.state.extractResult = err instanceof Error ? err.message : String(err);
  }
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
    case "done":
      return renderDoneStep(header, state);
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
  const rows: AppRow[] = state.apps.map((name) => ({
    name,
    description: "dotfile snapshots",
    value: name,
  }));
  const select = Select({ options: rows, flexGrow: 1 });
  select.on("itemSelected", (_i: number, opt: AppRow) => {
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
    Text({ content: "Select an app to browse its snapshots." }),
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
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `Preview: ${state.version?.id ?? "?"}` }),
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
      const target = input.value;
      state.extractTarget = target;
      const ctl: DotfilesController = {
        view: renderView(state, opts, syntaxStyle),
        handleKey: () => undefined,
        state,
      };
      void extractTarball(ctl, opts, state.version, target, syntaxStyle);
    },
  });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: `Extract: ${state.version?.id ?? "?"}` }),
    Text({ content: "Enter target directory and press Enter." }),
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
