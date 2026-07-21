// Fleet view: renders the live fleet roster from a `FleetService` owned by
// the app layer (slice B foundation). The service is passed in via
// constructor opts — the view itself owns NO subscription. onShow refreshes
// hosts via `ctx.api.getHealth()` (always) and starts a 30s polling timer
// cleared in onHide. Hotkeys: `r` refresh, `w` open the backup-setup wizard.

import { Box, Select, Text } from "@opentui/core";
import type {
  ProxiedVNode,
  Renderable,
  VNode,
} from "@opentui/core";
import type { BoxRenderable, SelectRenderable } from "@opentui/core";

import {
  createChildTracker,
  errorBox,
  hotkeyFooter,
  replaceChildren,
  statusBox,
} from "../app/widgets.ts";
import type { ChildTracker } from "../app/widgets.ts";
import type { Hotkey } from "../app/keymap.ts";
import type {
  View,
  ViewContext,
  ViewId,
} from "../app/view-manager.ts";
import type { Wizard } from "../app/wizard.ts";
import {
  createFleetService,
  type FleetHost,
  type FleetService,
} from "../app/fleet-service.ts";

// -----------------------------------------------------------------------------
// Public types — keep stable surface for callers and tests.
// -----------------------------------------------------------------------------

// Tab navigation now lives in the shell (1..5 / [ / ]). Fleet itself only
// exposes refresh + the wizard shortcut; everything else is the shell's job.
export type FleetAction = "refresh" | "back";

export interface FleetState {
  hosts: FleetHost[];
}

// Re-export the canonical FleetHost from the app-level service so callers
// can keep importing it from `views/fleet.ts`.
export type { FleetHost };

interface HostRow {
  name: string;
  description: string;
  value: string;
}

// -----------------------------------------------------------------------------
// Pure helpers — preserved from the previous fleet.ts so any downstream
// consumer of `isHost` / `toFleetHost` keeps working. The shape they operate
// on matches `@lamasync/core`'s `Host`; the local row materializer stays
// private to the view.
// -----------------------------------------------------------------------------

function isHostLike(value: unknown): value is { id: string; hostname: string; status: string; lastSeen?: number | null; tailnetIp?: string | null } {
  if (value === null || typeof value !== "object") return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.id === "string" &&
    typeof h.hostname === "string" &&
    typeof h.status === "string"
  );
}

function toFleetHostLike(host: {
  id: string;
  hostname: string;
  status: string;
  lastSeen?: number | null;
  tailnetIp?: string | null;
}): FleetHost {
  return {
    id: host.id,
    hostname: host.hostname,
    status: host.status,
    lastSeen: host.lastSeen ?? null,
    tailnetIp: host.tailnetIp ?? undefined,
  };
}

function describeHost(host: FleetHost, now: number): string {
  const status = host.status || "unknown";
  if (host.lastSeen === null || host.lastSeen === undefined) {
    return `${status} · never`;
  }
  return `${status} · ${formatLastSeen(host.lastSeen, now)}`;
}

function formatLastSeen(ts: number, now: number): string {
  const seconds = Math.floor((now - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function toRows(hosts: ReadonlyArray<FleetHost>, now: number): HostRow[] {
  return hosts.map((host) => ({
    name: host.hostname,
    description: describeHost(host, now),
    value: host.id,
  }));
}

// -----------------------------------------------------------------------------
// View
// -----------------------------------------------------------------------------

export interface FleetViewOpts {
  readonly service: FleetService;
  readonly serverUrl: string;
  readonly apiKey: string;
}

export class FleetView implements View {
  static readonly id: ViewId = "fleet";
  static readonly title = "Fleet";

  readonly id: ViewId = FleetView.id;
  readonly title: string = FleetView.title;

  private readonly service: FleetService;
  private readonly serverUrl: string;
  private readonly apiKey: string;

  private readonly bodyBox: ProxiedVNode<typeof BoxRenderable>;
  private readonly statusBlock: ProxiedVNode<typeof BoxRenderable>;
  private readonly selectRef: ProxiedVNode<typeof SelectRenderable>;
  private readonly selectContainer: ProxiedVNode<typeof BoxRenderable>;

  private ctx: ViewContext | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private loadId = 0;
  private statusText: string | null = null;
  private statusKind: "info" | "error" | "success" = "info";
  private refreshing = false;
  private readonly bodyTracker: ChildTracker = createChildTracker();
  private readonly statusTracker: ChildTracker = createChildTracker();

  // Single narrow cast at the field boundary — matches the pattern in
  // foundation's shell.ts and views/logs.ts.
  readonly container: Renderable;

  constructor(opts: FleetViewOpts) {
    this.service = opts.service;
    this.serverUrl = opts.serverUrl;
    this.apiKey = opts.apiKey;

    this.bodyBox = Box({ flexDirection: "column", flexGrow: 1 });
    this.statusBlock = Box({ flexDirection: "column" });
    this.selectRef = Select({ options: [], flexGrow: 1 });
    this.selectContainer = Box(
      { flexDirection: "column", flexGrow: 1 },
      this.selectRef,
    );
    this.container = Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      this.bodyBox,
      this.statusBlock,
    ) as unknown as Renderable;

    // First render deferred to onShow(): mutating a non-instantiated VNode
    // proxy throws "{} is not iterable" (see local.ts / dotfiles.ts).
  }

  // ---------------------------------------------------------------------------
  // Hotkeys — single declaration drives the footer render and dispatch.
  hotkeys(): ReadonlyArray<Hotkey> {
    return [
      { key: "r", label: "refresh", run: () => void this.refresh() },
      { key: "w", label: "new backup…", run: () => this.openBackupSetupWizard() },
    ];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    // First paint — the proxy is now parented by the Shell.
    this.renderBody();
    void this.refresh();
    if (this.pollTimer === null) {
      this.pollTimer = setInterval(() => {
        void this.refresh();
      }, 30_000);
    }
  }

  onHide(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Cancel any in-flight refresh so its setStatus doesn't bleed into the
    // next view after the user has already tabbed away.
    this.loadId++;
    this.ctx = null;
  }

  destroy(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Body rendering — mutates the inner Box only; the outer container stays
  // mounted across refreshes.
  // ---------------------------------------------------------------------------

  private renderBody(): void {
    const hosts = this.service.hosts;
    const status = this.service.status;
    const now = Date.now();

    const titleText: VNode = Text({ content: `Fleet — ${status === "live" ? "live" : "polling"}` });
    const countText: VNode = Text({
      content: `${hosts.length} host(s) known`,
    });

    const rows = toRows(hosts, now);
    this.selectRef.options = rows;

    const listContent: VNode =
      hosts.length === 0
        ? Box(
            { flexDirection: "column" },
            Text({ content: "(no hosts registered yet — press r to refresh)" }),
          )
        : this.selectContainer;

    const footerItems = this.hotkeys().map((h) => ({ key: h.key, label: h.label }));
    const footer: VNode = hotkeyFooter(footerItems);

    const bodyChildren: VNode[] = [
      titleText,
      countText,
      Text({ content: "" }),
      listContent,
      Text({ content: "" }),
      footer,
    ];

    replaceChildren(this.bodyBox, this.bodyTracker, bodyChildren);

    this.renderStatus();
  }

  private renderStatus(): void {
    const block = statusBox(this.statusText, this.statusKind);
    replaceChildren(this.statusBlock, this.statusTracker, block === null ? [] : [block]);
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

  private async refresh(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.refreshing) return;
    this.refreshing = true;
    const loadId = ++this.loadId;
    try {
      const health = await ctx.api.getHealth();
      if (loadId !== this.loadId) return;
      const liveHosts = health.hosts
        .filter(isHostLike)
        .map(toFleetHostLike);
      this.setStatus(`Loaded ${liveHosts.length} host(s).`, "success");
      this.renderBody();
    } catch (err) {
      if (loadId !== this.loadId) return;
      this.setStatus(
        `refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      this.refreshing = false;
    }
  }

  private openBackupSetupWizard(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.setStatus("wizard unavailable: no view context.", "error");
      return;
    }
    // Same wizard gesture as LocalView — slice I (flows/backup-setup.ts) will
    // replace this placeholder with the real step-wizard container.
    const wizard: Wizard = {
      id: "backup-setup",
      title: "New backup",
      container: errorBox(
        "Backup wizard not yet wired",
        "The backup-setup flow ships in a later slice. Until then, use the API or web UI to create folders.",
      ) as unknown as Renderable,
      onCancel: () => {
        // Shell removes the wizard from its registry when escape fires.
      },
    };
    try {
      ctx.openWizard(wizard);
    } catch {
      this.setStatus("wizard unavailable", "error");
    }
  }
}

// -----------------------------------------------------------------------------
// Public re-exports — keep the back-compat surface for any caller that still
// imports these names from `views/fleet.ts`. The implementation now lives in
// `app/fleet-service.ts`; we re-export here so external imports keep working.
// -----------------------------------------------------------------------------

export { createFleetService };
export type { FleetService } from "../app/fleet-service.ts";
export const isHost = isHostLike;
export const toFleetHost = toFleetHostLike;