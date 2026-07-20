// GitHub repos view: spawns `gh repo list` to enumerate repositories on the
// operator's GitHub account, and offers an adopt-repo flow that creates a
// git-folder via `ctx.api.createFolder(...)` + `ctx.api.assignFolder(...)`
// + a sync kick via the daemon socket.
//
// Implements the foundation `View` contract — the outer container is built
// once in the constructor; refreshes swap only the body Box's children. The
// legacy `handleGhKey` / `renderGhSelector` surface is preserved as inert
// no-ops so external callers still type-check; new code uses `GhView`.
// Adopt-repo flow uses the daemon socket's `requestSyncOne` for the initial
// sync kick.

import { Box, Select, Text } from "@opentui/core";
import type {
  BoxRenderable,
  KeyEvent,
  ProxiedVNode,
  Renderable,
  SelectRenderable,
  VNode,
} from "@opentui/core";
import { homedir } from "os";
import { join } from "path";

import { hotkeyFooter, pageShell, statusBox } from "../app/widgets.ts";
import type { Hotkey } from "../app/keymap.ts";
import { matchHotkey } from "../app/keymap.ts";
import type {
  View,
  ViewContext,
  ViewId,
} from "../app/view-manager.ts";
import { requestSyncOne } from "../socket-client.ts";

// -----------------------------------------------------------------------------
// Public types — kept stable for any consumer still importing the pre-slice
// names. `GhRepo` describes the shape `gh repo list --json` produces;
// `RenderGhSelectorOpts` is preserved as a marker so legacy callers compile.
// -----------------------------------------------------------------------------

export interface GhRepo {
  name: string;
  nameWithOwner: string;
  url: string;
}

export interface RenderGhSelectorOpts {
  repos: GhRepo[];
  error?: string | null;
  loading?: boolean;
  onSelect: (repo: GhRepo) => void;
  onCancel: () => void;
  onRefresh?: () => void;
}

interface RepoRow {
  name: string;
  description: string;
  value: string;
}

type BoxVNode = ProxiedVNode<typeof BoxRenderable>;

function toRows(repos: ReadonlyArray<GhRepo>): RepoRow[] {
  return repos.map((repo) => ({
    name: repo.name,
    description: repo.nameWithOwner,
    value: repo.nameWithOwner,
  }));
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

/**
 * GitHub repos view. Implements the foundation `View` contract.
 *
 * Lifecycle:
 *   - `onShow` kicks off the initial `gh repo list` fetch.
 *   - `r` re-runs the fetch (also surfaced through the hotkey footer).
 *   - Selecting a row in the Select triggers `adoptRepo`, which creates a
 *     `git` folder via `ctx.api.createFolder(...)`, assigns it to the
 *     current host with role `both`, and kicks an initial sync through the
 *     daemon socket.
 *
 * Errors surface both in the body Box (so the user can read the message)
 * and via `ctx.setStatus` (so the global status bar also reflects the
 * outcome).
 */
export class GhView implements View {
  static readonly id: ViewId = "gh";
  static readonly title = "GitHub";

  readonly id: ViewId = GhView.id;
  readonly title: string = GhView.title;

  private readonly bodyBox: BoxVNode;
  private readonly statusBlock: BoxVNode;
  // Per-render Select: built fresh on every renderBody() so the live
  // SelectRenderable instance is created alongside the bodyBox mount, not
  // held as an unparented proxy across re-renders. The itemSelected event
  // is wired via a closure that closes over this view instance.
  private currentSelect: ProxiedVNode<typeof SelectRenderable> | null = null;

  private repos: GhRepo[] = [];
  private loading = false;
  private error: string | null = null;
  private busy = false;

  private ctx: ViewContext | null = null;
  private loadId = 0;

  readonly container: Renderable;

  constructor(opts: { ctx: ViewContext }) {
    this.bodyBox = Box({ flexDirection: "column", flexGrow: 1 });
    this.statusBlock = Box({ flexDirection: "column" });
    this.container = pageShell(
      "GitHub",
      Box(
        { flexDirection: "column", flexGrow: 1 },
        this.bodyBox,
        this.statusBlock,
      ),
    ) as unknown as Renderable;
    // First render deferred to onShow — bodyBox proxy is unparented here.
  }

  // ---------------------------------------------------------------------------
  // Hotkeys — refresh is the only one the View owns; navigation between tabs
  // is the Shell's job.
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
    // First paint — bodyBox is now parented by the Shell.
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
    const match = matchHotkey(this.hotkeys(), name, char);
    if (!match) return false;
    void Promise.resolve(match.run());
    return true;
  }

  destroy(): void {
    this.loadId++;
    this.ctx = null;
  }

  // ---------------------------------------------------------------------------
  // Body rendering — mutates the inner Box only.
  // ---------------------------------------------------------------------------

  private renderBody(): void {
    const rows = toRows(this.repos);

    let main: VNode;
    if (this.loading && this.repos.length === 0) {
      main = Box(
        { flexDirection: "column" },
        Text({ content: "Loading GitHub repos…" }),
      );
    } else if (this.error && this.repos.length === 0) {
      main = Box(
        { flexDirection: "column" },
        Text({ content: `[!] ${this.error}` }),
        Text({ content: "Press r to retry." }),
      );
    } else if (this.repos.length === 0) {
      main = Box(
        { flexDirection: "column" },
        Text({
          content:
            "(no repos — make sure `gh auth status` succeeds, then press r)",
        }),
      );
    } else {
      // Build a fresh Select per render so the live SelectRenderable is
      // created at the same time as the parent Box — no stale-proxy
      // mutation across re-renders.
      const select = Select({ options: rows, flexGrow: 1 });
      select.on("itemSelected", (_i: number, opt: RepoRow) => {
        const repo = this.repos.find((r) => r.nameWithOwner === opt.value);
        if (!repo) return;
        void this.adoptRepo(repo);
      });
      this.currentSelect = select;
      main = Box({ flexDirection: "column", flexGrow: 1 }, select);
    }

    const children: VNode[] = [
      Text({
        content: this.busy
          ? "Adopting repo…"
          : `${this.repos.length} repo(s). Use ↑/↓ to move, Enter to adopt.`,
      }),
      Text({ content: "" }),
      main,
      Text({ content: "" }),
      hotkeyFooter(this.hotkeys().map((h) => ({ key: h.key, label: h.label }))),
    ];

    const existing = this.bodyBox.getChildren() as unknown as ReadonlyArray<Renderable>;
    for (const child of existing) {
      this.bodyBox.remove(child.id);
    }
    for (const node of children) {
      this.bodyBox.add(node);
    }

    const status = statusBox(this.error, "error");
    const existingStatus = this.statusBlock.getChildren() as unknown as ReadonlyArray<Renderable>;
    for (const child of existingStatus) {
      this.statusBlock.remove(child.id);
    }
    if (status !== null) {
      this.statusBlock.add(status);
    }
  }

  // ---------------------------------------------------------------------------
  // Data fetch
  // ---------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.loadId++;
    const myLoad = this.loadId;
    this.loading = true;
    this.error = null;
    this.renderBody();
    try {
      const repos = await fetchGhRepos();
      if (myLoad !== this.loadId) return;
      this.repos = repos;
    } catch (err) {
      if (myLoad !== this.loadId) return;
      this.error = err instanceof Error ? err.message : String(err);
      ctx.setStatus(`gh: ${this.error}`, "error");
    } finally {
      if (myLoad === this.loadId) {
        this.loading = false;
        this.renderBody();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Adopt flow
  // ---------------------------------------------------------------------------

  private async adoptRepo(repo: GhRepo): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.busy) return;
    this.busy = true;
    const myLoad = ++this.loadId;
    this.renderBody();
    try {
      const folder = await ctx.api.createFolder({
        name: repo.name,
        type: "git",
        gitProvider: "gh",
        gitRemote: repo.nameWithOwner,
        encrypted: false,
        cryptPassword: null,
      });
      if (myLoad !== this.loadId) return;
      await ctx.api.assignFolder(folder.id, {
        folderId: folder.id,
        hostId: ctx.hostname,
        role: "both",
        localPath: join(homedir(), "projects", repo.name),
        enabled: true,
      });
      if (myLoad !== this.loadId) return;
      // requestSyncOne uses the configured daemon socket via ctx.socketPath;
      // see P2 (TuiDotfilesGh.ReviewDotfilesGh). Surface adoption-failure
      // distinctly from initial-sync-failure so the status bar isn't a
      // false "adopted" message after a swallowed socket error.
      try {
        await requestSyncOne(folder.id, ctx.socketPath);
        if (myLoad !== this.loadId) return;
      } catch (err) {
        if (myLoad !== this.loadId) return;
        const msg = err instanceof Error ? err.message : String(err);
        ctx.setStatus(
          `adopt succeeded but initial sync failed against ${ctx.socketPath}: ${msg}`,
          "error",
        );
        this.error = msg;
        return;
      }
      ctx.setStatus(
        `adopted ${repo.nameWithOwner} → ${folder.name} (${folder.id})`,
        "success",
      );
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      ctx.setStatus(`adopt failed: ${this.error}`, "error");
    } finally {
      this.busy = false;
      if (myLoad === this.loadId) this.renderBody();
    }
  }
}

// -----------------------------------------------------------------------------
// `gh repo list` JSON parser — kept module-private so the view's `refresh`
// stays readable. Tolerates the legacy `--json` shape and silently drops
// entries missing the required fields.
// -----------------------------------------------------------------------------

interface RawGhRow {
  name?: unknown;
  nameWithOwner?: unknown;
  url?: unknown;
}

function fetchGhRepos(): Promise<GhRepo[]> {
  return new Promise<GhRepo[]>((resolve, reject) => {
    if (typeof Bun === "undefined" || typeof Bun.spawnSync !== "function") {
      reject(new Error("gh fetch requires Bun runtime"));
      return;
    }
    if (!Bun.which("gh")) {
      reject(new Error("gh CLI not found in PATH"));
      return;
    }
    const proc = Bun.spawnSync({
      cmd: [
        "gh",
        "repo",
        "list",
        "--json",
        "name,nameWithOwner,url",
        "-L",
        "100",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      const errTail = new TextDecoder().decode(proc.stderr).slice(-500);
      reject(new Error(`gh repo list failed (exit ${proc.exitCode}): ${errTail}`));
      return;
    }
    try {
      const stdout = new TextDecoder().decode(proc.stdout);
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) {
        resolve([]);
        return;
      }
      const repos: GhRepo[] = [];
      for (const entry of parsed) {
        if (entry === null || typeof entry !== "object") continue;
        const row = entry as RawGhRow;
        if (
          typeof row.name !== "string" ||
          typeof row.nameWithOwner !== "string" ||
          typeof row.url !== "string"
        ) {
          continue;
        }
        if (row.name === "" || row.nameWithOwner === "") continue;
        repos.push({
          name: row.name,
          nameWithOwner: row.nameWithOwner,
          url: row.url,
        });
      }
      resolve(repos);
    } catch (err) {
      reject(
        err instanceof Error
          ? err
          : new Error(`failed to parse gh output: ${String(err)}`),
      );
    }
  });
}



/**
 * Back-compat factory preserved per LAMA-173 review (round 4). External
 * harnesses may still import renderGhSelector / handleGhKey. Slice J's
 * boot.ts does NOT depend on this — only the View class is wired through
 * the Shell. The wrapper builds a stub ViewContext and calls view.onShow
 * to ensure the controller's refresh kicks off.
 */
export function renderGhSelector(opts: RenderGhSelectorOpts): VNode {
  const repo = opts.repos;
  const header = Text({ content: "GitHub Repos" });
  let body: VNode;
  if (opts.loading) {
    body = Box(
      { flexDirection: "column" },
      Text({ content: "Loading GitHub repos…" }),
    );
  } else if (opts.error) {
    body = Box(
      { flexDirection: "column" },
      Text({ content: `[!] ${opts.error}` }),
      Text({ content: "Press r to retry." }),
    );
  } else if (repo.length === 0) {
    body = Box(
      { flexDirection: "column" },
      Text({
        content: "(no repos — make sure \`gh auth status\` succeeds, then press r)",
      }),
    );
  } else {
    const rows: RepoRow[] = repo.map((r) => ({
      name: r.name,
      description: `${r.nameWithOwner}`,
      value: r.nameWithOwner,
    }));
    const select = Select({ options: rows, flexGrow: 1 });
    // Forward Enter (itemSelected) to opts.onSelect — old behaviour.
    if (opts.onSelect) {
      select.on("itemSelected", (_i: number, opt: RepoRow) => {
        const found = repo.find((r) => r.nameWithOwner === opt.value);
        if (found) opts.onSelect!(found);
      });
    }
    body = Box({ flexDirection: "column", flexGrow: 1 }, select);
  }
  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    body,
    Text({ content: "" }),
    Text({
      content:
        opts.repos.length > 0
          ? `${opts.repos.length} repo(s). Use ↑/↓ to move, Enter to adopt.`
          : "",
    }),
  );
}

/**
 * Back-compat key handler for renderGhSelector callers. Returns true if
 * the event was consumed.
 *
 *   - escape / q        → opts.onCancel
 *   - r                 → opts.onRefresh (if provided)
 *   - Enter             → Select widget owns it (itemSelected → opts.onSelect)
 *
 * Matches the pre-slice TUI behaviour.
 */
export function handleGhKey(
  e: KeyEvent,
  opts: RenderGhSelectorOpts,
): boolean {
  const name = (typeof e.name === "string" ? e.name : "").toLowerCase();
  const raw = typeof e.raw === "string" ? e.raw : "";
  const char = raw.length === 1 ? raw.toLowerCase() : "";
  if (name === "escape" || char === "q") {
    opts.onCancel();
    return true;
  }
  if (char === "r" && opts.onRefresh) {
    opts.onRefresh();
    return true;
  }
  return false;
}
