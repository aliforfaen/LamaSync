// Local view: lists assigned folders, drives sync/cache/switch/share actions
// over the daemon socket, and opens the backup-setup wizard on `w`. Implements
// the foundation `View` contract: a `pageShell` with a folder Select, a hotkey
// footer, and a status Block — all built once in the constructor; refreshes
// mutate the inner body Box (cheap), never the outer container.

import { Box, Select, Text } from "@opentui/core";
import type {
  CliRenderer,
  Renderable,
  VNode,
} from "@opentui/core";
import type { BoxRenderable, SelectRenderable } from "@opentui/core";

import {
  hotkeyFooter,
  pageShell,
  realize,
  statusBox,
  swapChildren,
} from "../app/widgets.ts";
import type { Hotkey } from "../app/keymap.ts";
import { PALETTE_BG, SELECTION } from "../app/palette.ts";
import type {
  View,
  ViewContext,
  ViewId,
} from "../app/view-manager.ts";
import { friendlyError } from "../friendly-error.ts";
import { createBackupSetupWizard } from "../flows/backup-setup.ts";
import {
  requestSwitchMount,
  requestSwitchSync,
  requestSyncAll,
  requestSyncOne,
} from "../socket-client.ts";

// -----------------------------------------------------------------------------
// Public types — kept stable for the existing `describeFolder` tests and any
// callers that still use the View-state shape.
// -----------------------------------------------------------------------------

export type LocalAction =
  | "sync-all"
  | "sync-one"
  | "refresh"
  | "cache-profile"
  | "switch-type"
  | "network-shares";

export type LocalFolderType = "sync" | "mount" | "backup" | "dotfile" | "git";

export type LocalFolderBackend = "sftp" | "s3" | "local" | "nfs" | "restic";

export type GitProvider = "git" | "gh";
export type CacheProfileKind = "normal" | "media" | "minimal";

export interface LocalFolder {
  id: string;
  hostId: string;
  name: string;
  type?: LocalFolderType;
  lastStatus?: string;
  lastRun?: number | null;
  cacheProfile?: CacheProfileKind | null;
  cacheMaxSize?: string | null;
  gitProvider?: GitProvider | null;
  gitRemote?: string | null;
  backend?: LocalFolderBackend | null;
}

export interface LocalState {
  folders: LocalFolder[];
  hostname: string;
  selectedFolderId: string | null;
  status: string | null;
  statusKind: "info" | "error" | "success";
}

export interface RenderLocalOpts {
  state: LocalState;
  onAction: (action: LocalAction) => void;
  onSelectFolder: (folderId: string) => void;
}

export interface FstabShareInput {
  id: string;
  server: string;
  path: string;
  type: "nfs" | "smb";
  options: string;
}

export const CACHE_PROFILE_ORDER: readonly CacheProfileKind[] = [
  "normal",
  "media",
  "minimal",
];

// -----------------------------------------------------------------------------
// Pure helpers — unchanged behavior, kept under their original names so the
// existing `describeFolder` tests and `nextCacheProfile` consumers keep working.
// -----------------------------------------------------------------------------

export function describeFolder(folder: LocalFolder): string {
  const status = folder.lastStatus ?? "unknown";
  const type = folder.type ?? "sync";
  let displayType: string = type;
  if (type === "git" && folder.gitProvider === "gh") {
    const remote = folder.gitRemote ? `:${folder.gitRemote}` : "";
    displayType = `gh${remote}`;
  }
  const cache =
    type === "mount" && folder.cacheProfile
      ? ` (cache: ${folder.cacheProfile}${folder.cacheMaxSize ? `/${folder.cacheMaxSize}` : ""})`
      : "";
  const backend =
    folder.backend && folder.backend !== "sftp" ? ` [${folder.backend}]` : "";
  return `${displayType}${cache}${backend} — ${status}`;
}

export function nextCacheProfile(
  current: CacheProfileKind | null | undefined,
): CacheProfileKind {
  const idx = CACHE_PROFILE_ORDER.indexOf(current ?? "normal");
  const safeIdx = idx === -1 ? 0 : idx;
  const next = CACHE_PROFILE_ORDER[(safeIdx + 1) % CACHE_PROFILE_ORDER.length]!;
  return next;
}

export function buildFstabLine(
  share: FstabShareInput,
  mountPoint: string,
): string {
  const fsType = share.type === "nfs" ? "nfs" : "cifs";
  const options =
    share.options && share.options.length > 0 ? share.options : "defaults";
  return `${share.server}:${share.path} ${mountPoint} ${fsType} ${options} 0 0 # lamasync:${share.id}`;
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

interface FolderRow {
  name: string;
  description: string;
  value: string;
}

export class LocalView implements View {
  static readonly id: ViewId = "local";
  static readonly title = "This device";

  readonly id: ViewId = LocalView.id;
  readonly title: string = LocalView.title;

  private readonly bodyBox: BoxRenderable;
  private readonly statusBlock: BoxRenderable;
  private readonly actionFooter: BoxRenderable;
  private readonly selectRef: SelectRenderable;
  private readonly selectContainer: BoxRenderable;

  private folders: LocalFolder[] = [];
  private hostname = "";
  private selectedFolderId: string | null = null;
  private statusText: string | null = null;
  private statusKind: "info" | "error" | "success" = "info";
  private ctx: ViewContext | null = null;
  private loadId = 0;

  // Real renderable instantiated against the renderer (LAMA-181); the
  // ViewManager flips `visible` on it when switching tabs.
  readonly container: Renderable;

  constructor(opts?: { renderer?: CliRenderer | null }) {
    const renderer = opts?.renderer ?? null;
    this.bodyBox = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    );
    this.statusBlock = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column" }),
    );
    this.selectRef = realize<SelectRenderable>(
      renderer,
      Select({
        options: [],
        flexGrow: 1,
        selectedBackgroundColor: PALETTE_BG.accent,
        selectedTextColor: SELECTION.fg,
      }),
    );
    this.selectRef.on("itemSelected", (_index: number, option: FolderRow) => {
      if (option.value) {
        this.selectedFolderId = option.value;
        // LAMA-276 contextual actions: the footer reflects the newly
        // selected folder without re-rendering (and re-focusing) the Select.
        this.renderActionFooter();
      }
    });
    this.selectContainer = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column", flexGrow: 1 }, this.selectRef),
    );
    // Contextual action area: a real renderable kept separate from the
    // bodyBox so selection changes can repaint it without touching the
    // focusable Select (LAMA-181).
    this.actionFooter = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column" }),
    );
    this.container = realize<Renderable>(
      renderer,
      pageShell(
        null, // dynamic heading rendered in renderBody ("This device — hostname")
        Box(
          { flexDirection: "column", flexGrow: 1 },
          this.bodyBox,
          this.actionFooter,
          this.statusBlock,
        ),
      ),
    );

    // First render is deferred to onShow(): the hostname comes from the
    // ViewContext, so there is nothing meaningful to paint before then.
  }

  // ---------------------------------------------------------------------------
  // Hotkeys — single declaration drives both the footer render and dispatch.
  // ---------------------------------------------------------------------------

  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "1", label: "sync all", run: () => this.runSyncAll() },
      { key: "2", label: "sync one", run: () => this.runSyncOne() },
      { key: "3", label: "refresh", run: () => this.refresh() },
      { key: "p", label: "cache profile", run: () => this.cycleCacheProfile() },
      { key: "s", label: "switch type", run: () => this.switchType() },
      { key: "n", label: "network shares", run: () => this.showNetworkShares() },
      { key: "w", label: "new backup…", run: () => this.openBackupSetupWizard() },
    ];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    this.hostname = ctx.hostname;
    // First paint — bodyBox is a real renderable, so mutations render live.
    this.renderBody();
    void this.refresh();
  }

  onHide(): void {
    // Cancel any in-flight refresh so its setStatus doesn't bleed into the
    // next view after the user has already tabbed away.
    this.loadId++;
    this.ctx = null;
  }

  // ---------------------------------------------------------------------------
  // Body rendering — mutates the inner Box only; the outer container is
  // untouched so re-renders are cheap.
  // ---------------------------------------------------------------------------

  private renderBody(): void {
    const titleText: VNode = Text({ content: `This device — ${this.hostname || "—"}` });
    const listContent: VNode | Renderable =
      this.folders.length === 0
        ? Box(
            { flexDirection: "column" },
            Text({ content: "No folders set up on this device yet." }),
            Text({ content: "Press w to create a backup, 3 to refresh." }),
          )
        : this.selectContainer;

    const bodyChildren: Array<VNode | Renderable> = [
      titleText,
      Text({ content: "" }),
      listContent,
      Text({ content: "" }),
    ];
    swapChildren(this.bodyBox, bodyChildren);
    this.refreshSelectOptions();
    this.renderActionFooter();
    this.renderStatus();
  }

  /**
   * LAMA-276 contextual actions: the footer area names the actions for the
   * selected folder (sync, cache profile, switch type, shares) above the
   * always-visible global row, so a newcomer sees what each key does for the
   * highlighted item instead of memorizing hotkeys. Fast one-key dispatch is
   * unchanged (hotkeys() drives handleKey).
   */
  private renderActionFooter(): void {
    const selected = this.selectedFolder();
    const lines: Array<VNode | Renderable> = [];
    if (selected) {
      lines.push(
        Text({ content: `Selected: ${selected.name}` }),
        hotkeyFooter([
          { key: "2", label: `sync ${selected.name}` },
          { key: "p", label: "cache profile" },
          { key: "s", label: "switch type" },
          { key: "n", label: "network shares" },
        ]),
      );
    }
    lines.push(
      hotkeyFooter([
        { key: "1", label: "sync all" },
        { key: "3", label: "refresh" },
        { key: "w", label: "new backup…" },
      ]),
    );
    swapChildren(this.actionFooter, lines);
  }

  private refreshSelectOptions(): void {
    const rows: FolderRow[] = this.folders.map((folder) => ({
      name: folder.name,
      description: describeFolder(folder),
      value: folder.id,
    }));
    this.selectRef.options = rows;
  }

  private renderStatus(): void {
    const block = statusBox(this.statusText, this.statusKind);
    swapChildren(this.statusBlock, block === null ? [] : [block]);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private setStatus(
    msg: string | null,
    kind: "info" | "error" | "success" = "info",
  ): void {
    this.statusText = msg;
    this.statusKind = kind;
    this.renderStatus();
    if (this.ctx) {
      this.ctx.setStatus(msg ?? "", kind);
    }
  }
  private selectedFolder(): LocalFolder | null {
    if (this.selectedFolderId) {
      const found = this.folders.find((f) => f.id === this.selectedFolderId);
      if (found) return found;
    }
    return this.folders[0] ?? null;
  }

  private async refresh(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    const loadId = ++this.loadId;
    try {
      const [folders, config] = await Promise.all([
        ctx.api.listFolders(),
        ctx.api.getConfig(ctx.hostname).catch(() => null),
      ]);
      if (loadId !== this.loadId) return;
      const byId = new Map(
        (config?.assignments ?? []).map((a) => [a.folderId, a]),
      );
      this.folders = folders.map((f) => {
        const a = byId.get(f.id);
        return {
          id: f.id,
          hostId: a?.hostId ?? ctx.hostname,
          name: f.name,
          type: f.type,
          lastStatus: undefined,
          lastRun: null,
          cacheProfile: a?.cacheProfile ?? null,
          cacheMaxSize: a?.cacheMaxSize ?? null,
          gitProvider: f.gitProvider ?? null,
          gitRemote: f.gitRemote ?? null,
          backend: f.backend ?? null,
        };
      });
      this.setStatus(`Loaded ${this.folders.length} folder(s).`, "success");
      this.renderBody();
    } catch (err) {
      if (loadId !== this.loadId) return;
      this.folders = [];
      this.renderBody();
      this.setStatus(
        `refresh failed: ${friendlyError(err)}`,
        "error",
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Hotkey actions
  // ---------------------------------------------------------------------------

  private async runSyncAll(): Promise<void> {
    this.setStatus("Queueing sync for every assigned folder…", "info");
    try {
      const res = (await requestSyncAll(this.ctx?.socketPath)) as { started: boolean; all: boolean };
      this.setStatus(
        res?.started
          ? "Sync queued for all assigned folders."
          : "Daemon accepted sync-all but returned no started flag.",
        "success",
      );
    } catch (err) {
      this.setStatus(
        `sync-all failed: ${friendlyError(err)}`,
        "error",
      );
    }
  }

  private async runSyncOne(): Promise<void> {
    const folder = this.selectedFolder();
    if (!folder) {
      this.setStatus("sync-one: no folder selected.", "error");
      return;
    }
    this.setStatus(`Queueing sync for ${folder.name}…`, "info");
    try {
      const res = (await requestSyncOne(folder.id, this.ctx?.socketPath)) as {
        started: boolean;
        folderId: string;
      };
      this.setStatus(
        res?.started
          ? `Sync queued for ${folder.name}.`
          : `Daemon accepted sync but returned no started flag for ${folder.name}.`,
        "success",
      );
    } catch (err) {
      this.setStatus(
        `sync-one failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  private async cycleCacheProfile(): Promise<void> {
    const ctx = this.ctx;
    const folder = this.selectedFolder();
    if (!folder) {
      this.setStatus("cache-profile: no folder selected.", "error");
      return;
    }
    if (folder.type !== "mount") {
      this.setStatus(
        `cache-profile only applies to mount folders; ${folder.name} is ${folder.type ?? "sync"}.`,
        "error",
      );
      return;
    }
    const next = nextCacheProfile(folder.cacheProfile);
    this.setStatus(
      `cache-profile: ${folder.name} ${folder.cacheProfile ?? "normal"} -> ${next} (writing through server…)`,
      "info",
    );
    try {
      if (ctx) {
        await ctx.api.updateAssignment(folder.id, folder.hostId, {
          cacheProfile: next,
        });
      }
      this.setStatus(
        `cache-profile updated: ${folder.name} -> ${next}.`,
        "success",
      );
      await this.refresh();
    } catch (err) {
      this.setStatus(
        `cache-profile failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  private async switchType(): Promise<void> {
    const folder = this.selectedFolder();
    if (!folder) {
      this.setStatus("switch-type: no folder selected.", "error");
      return;
    }
    const folderType = folder.type ?? "sync";
    const target: "sync" | "mount" = folderType === "mount" ? "sync" : "mount";
    this.setStatus(
      `switch-type: ${folder.name} ${folderType} -> ${target}; awaiting daemon…`,
      "info",
    );
    try {
      // WS3: the daemon's raw JSON response is noise in the status bar —
      // surface the outcome, not the payload.
      if (target === "mount") {
        await requestSwitchMount(folder.id);
      } else {
        await requestSwitchSync(folder.id);
      }
      this.setStatus(
        `switched ${folder.name} to ${target === "mount" ? "mount" : "sync"}`,
        "success",
      );
    } catch (err) {
      this.setStatus(
        `switch-type failed: ${friendlyError(err)}`,
        "error",
      );
    }
  }

  private async showNetworkShares(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      this.setStatus("network-shares: no context.", "error");
      return;
    }
    try {
      const shares = await ctx.api.listShares();
      if (shares.length === 0) {
        this.setStatus(
          "network-shares: no shares configured (set LAMASYNC_SHARES or shares.json).",
          "error",
        );
        return;
      }
      const lines: string[] = [];
      for (const share of shares) {
        const mountPoint = `/mnt/lamasync/${share.id}`;
        lines.push(buildFstabLine(share, mountPoint));
      }
      this.setStatus(
        `network-shares: copy these lines into /etc/fstab, then run \`sudo mount -a\`:\n  ${lines.join("\n  ")}`,
        "info",
      );
    } catch (err) {
      this.setStatus(
        `network-shares failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  private openBackupSetupWizard(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.setStatus("wizard unavailable: no view context.", "error");
      return;
    }
    ctx.openWizard(createBackupSetupWizard({ ctx }));
  }
}
