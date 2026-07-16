import { Box, Select, Text } from "@opentui/core";
import type { KeyEvent, VNode } from "@opentui/core";

/**
 * A single GitHub repository row as returned by `gh repo list --json name,nameWithOwner,url`.
 */
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

function toRows(repos: GhRepo[]): RepoRow[] {
  return repos.map((repo) => ({
    name: repo.name,
    description: `${repo.nameWithOwner} — ${repo.url}`,
    value: repo.nameWithOwner,
  }));
}

/**
 * Build the `gh` (GitHub repo) selector view. The view is a styled list of
 * repositories pulled from `gh repo list` with cancel/refresh hotkeys.
 *
 * - When `error` is non-null, render an error Text and instructions.
 * - When `loading` is true, render a "Loading…" placeholder.
 * - Otherwise render the `Select` list with hotkey footer.
 */
export function renderGhSelector(opts: RenderGhSelectorOpts): VNode {
  const header = Text({ content: "GitHub repos" });

  if (opts.error) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: `Error: ${opts.error}` }),
      Text({ content: "Make sure `gh` is installed and authenticated." }),
      Text({ content: "Press Esc or q to return. Press r to retry." }),
    );
  }

  if (opts.loading) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: "Loading repositories from `gh repo list`…" }),
      Text({ content: "Press Esc or q to cancel." }),
    );
  }

  if (opts.repos.length === 0) {
    return Box(
      { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
      header,
      Text({ content: "No repositories found on the authenticated GitHub account." }),
      Text({ content: "Press r to refresh, or q/Esc to return." }),
    );
  }

  const rows = toRows(opts.repos);
  const select = Select({ options: rows, flexGrow: 1 });
  select.on("itemSelected", (_index: number, option: RepoRow) => {
    const repo = opts.repos.find((r) => r.nameWithOwner === option.value);
    if (repo) opts.onSelect(repo);
  });

  return Box(
    { flexDirection: "column", padding: 1, border: true, flexGrow: 1 },
    header,
    Text({ content: "Use ↑/↓ to move, Enter to select a repo to sync." }),
    Text({ content: "[Enter] select  [r] refresh  [q/Esc] cancel" }),
    Text({ content: "" }),
    select,
  );
}

/**
 * Default key handler for the gh-selector view. Dispatched to by the root
 * key handler when `state.view === "gh"`. Returns true if the event was
 * consumed; callers should redraw afterward regardless.
 */
export function handleGhKey(e: KeyEvent, opts: RenderGhSelectorOpts): boolean {
  const name = (e.name ?? "").toLowerCase();
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
