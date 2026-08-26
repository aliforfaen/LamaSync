// LAMA-259: time-travel browser — folder-scoped snapshot history + per-
// snapshot file listing. Two GET endpoints back the Data Browser's
// "history mode" slider:
//
//   GET /api/v1/folders/:id/snapshots
//     → { snapshots: FolderSnapshot[] }
//     Reads straight from the `restic_snapshots` table (daemon-posted
//     rows from POST /restic/snapshots). Folders that aren't backed by a
//     restic repository return `{ snapshots: [] }` so the UI can hide the
//     slider cleanly. Folder-not-found → 404.
//
//   GET /api/v1/folders/:id/snapshots/:snapshotId/files?path=...
//     → BrowseResponse (backend: "restic-snapshot")
//     Spawns `restic ls --json <snap>[:<path>]` against the folder's
//     configured restic repository, parses the JSON-lines output (sharing
//     the pattern from health-drill.ts), and returns a BrowseResponse the
//     DataBrowser can render with the same component as live folders.
//     Limit caps the entry count (default 500, max 5000). Non-restic
//     folders → 409 with the same wording the prove/drill routes use.
//
// Read-only: never writes to a real folder, never opens a tempdir. The
// restic password lives in `RESTIC_PASSWORD` env of the spawned process;
// never in argv (LAMA-226 defense-in-depth).

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type {
  BrowseEntry,
  BrowseResponse,
  FolderSnapshot,
  FolderSnapshotsResponse,
} from "@lamasync/core";
import { resolveFolderResticConfig } from "../backends.ts";
import {
  parseLsJsonRich,
  scrubFailureSummary,
} from "../health-drill.ts";

// ---------- test seam ----------------------------------------------------

/** Subset of the restic spawn surface that the snapshots module needs.
 *  Lifted from the health-drill module so the two features can mock
 *  independently in tests (each beforeEach resets its own seam). */
export interface ResticSpawnInput {
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ResticSpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ResticSpawnFn = (
  input: ResticSpawnInput,
) => Promise<ResticSpawnResult>;

let activeRunner: ResticSpawnFn = defaultResticRunner;

/** Test seam — substitute a fake runner to assert argv + scrub behavior.
 *  Pass `null` to reset to the real `Bun.spawn` default between tests. */
export function __setResticRunnerForTests(fn: ResticSpawnFn | null): void {
  activeRunner = fn ?? defaultResticRunner;
}

async function defaultResticRunner(
  input: ResticSpawnInput,
): Promise<ResticSpawnResult> {
  // LAMA-226: the password MUST live in env, not argv (process-list
  // exposure). We spread the caller's process.env first so it inherits
  // PATH / locale / etc., then merge the caller-provided env map last
  // so RESTIC_PASSWORD always wins.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  if (input.env) Object.assign(env, input.env);
  const proc = Bun.spawn(["restic", ...input.args], {
    env,
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

// ---------- DB seam ------------------------------------------------------

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

// ---------- pure helpers (exported for unit tests) -----------------------

interface ResticSnapshotRow {
  snapshot_id: string;
  timestamp: number;
  host_id: string;
  paths: string | null;
}

/** Shape returned to the UI: thinnest possible {id, time, host?, paths?}. */
export function rowToFolderSnapshot(r: ResticSnapshotRow): FolderSnapshot {
  let paths: string[] | undefined;
  if (r.paths) {
    try {
      const parsed: unknown = JSON.parse(r.paths);
      if (Array.isArray(parsed)) {
        paths = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      paths = undefined;
    }
  }
  return {
    id: r.snapshot_id,
    time: r.timestamp,
    host: r.host_id,
    paths,
  };
}

/** True if `p` is inside `prefix` (or is the prefix itself). Both
 *  arguments are expected to be restic-style absolute paths (leading
 *  slash, no trailing slash). Used to filter parseLsJsonRich output to
 *  the requested directory listing — restic emits the whole subtree under
 *  the prefix, the browser only wants one level. */
function pathIsUnderOrEqual(p: string, prefix: string): boolean {
  if (prefix === "/") return p.startsWith("/");
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** The leaf name from a restic absolute path. Stable for the UI:
 *  - "/" → "" (the root has no leaf)
 *  - "/foo" → "foo"
 *  - "/foo/bar" → "bar"
 *  - "/foo/" → "foo" (defensive — restic normalizes away the trailing
 *    slash, but a future build could surface it).
 */
function leafFromPath(p: string): string {
  if (p === "/" || p === "") return "";
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Build the `restic ls` argv. `<snap>` is restic's snapshot id; `<path>`
 *  is an absolute restic-style prefix. Empty / "/" paths omit the colon
 *  and pass the bare snapshot id so the listing is the snapshot root. */
function resticLsArgs(
  snapshot: string,
  pathPrefix: string,
  repo: string,
): string[] {
  const trimmed = pathPrefix.replace(/\/+$/u, "");
  const target = trimmed === "" || trimmed === "/" ? snapshot : `${snapshot}:${trimmed}`;
  return ["ls", "--json", target, "-r", repo];
}

const DEFAULT_FILES_LIMIT = 500;
const MAX_FILES_LIMIT = 5000;

function clampFilesLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.min(MAX_FILES_LIMIT, Math.max(1, Math.floor(raw)));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) {
      return Math.min(MAX_FILES_LIMIT, Math.max(1, n));
    }
  }
  return DEFAULT_FILES_LIMIT;
}

/** Build a BrowseResponse from raw `restic ls --json` output, clipped to
 *  one level under `pathPrefix` (restic returns the subtree). The output
 *  is sorted alphabetically by name so the UI's stable sort isn't
 *  fighting a server-stable sort. */
export function resticLsResponse(
  stdout: string,
  pathPrefix: string,
  snapshotId: string,
  folderId: string,
  limit: number,
): BrowseResponse {
  const raw = parseLsJsonRich(stdout);
  const filtered = raw.filter((e) => pathIsUnderOrEqual(e.path, pathPrefix));
  // Strip the requested prefix off the path so `pathIsUnderOrEqual("/a",
  // "/a")` → "" (correct: root), `pathIsUnderOrEqual("/a/b", "/a")` →
  // "/b" (which then has leaf "b"). For the root listing we want the
  // immediate children of `pathPrefix`, so the relative path must be
  // exactly one segment.
  const children: LsBrowseRow[] = [];
  for (const e of filtered) {
    if (e.path === pathPrefix) continue; // the prefix itself isn't a child
    const rel = pathPrefix === "/" ? e.path : e.path.slice(pathPrefix.length);
    if (rel === "" || rel.startsWith("/")) {
      // Slice off the leading slash so a child "/foo" becomes "foo",
      // which is what we want to feed `leafFromPath` later.
      const trimmedRel = rel.replace(/^\/+/, "");
      // Only ONE level deep — anything with a remaining separator is a
      // grandchild we'll reach on a follow-up navigation request.
      if (trimmedRel === "" || trimmedRel.includes("/")) continue;
      children.push({
        name: trimmedRel,
        size: e.size,
        isDir: e.isDir,
        mtime: e.mtime,
      });
    }
  }
  // Stable sort by name (case-sensitive — case-insensitive would
  // visibly shuffle display when the user toggles case-fold).
  children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const capped = children.slice(0, limit);
  const entries: BrowseEntry[] = capped.map((c) => ({
    name: c.name,
    type: c.isDir ? "dir" : "file",
    size: c.size,
    // BrowseEntry.mtime is required; render missing as 0 — same sentinel
    // DataBrowser already uses for live listing fallbacks.
    mtime: c.mtime ?? 0,
    folderId,
  }));
  return {
    backend: "restic-snapshot",
    path: pathPrefix,
    entries,
    snapshotId,
    folderId,
  };
}

interface LsBrowseRow {
  name: string;
  size: number;
  isDir: boolean;
  mtime: number | null;
}

// ---------- restic invocation --------------------------------------------

interface FolderListingContext {
  backendId: string;
  repository: string;
  /** Decrypted password — never log or serialize this. */
  password: string;
}

/** Resolve a folder to its restic repository + password. Returns null
 *  for non-restic folders so the route layer can decide on an empty
 *  snapshot list (for /snapshots) vs a 409 (for /files). */
function resolveContextForFolder(
  folderId: string,
): FolderListingContext | null {
  const row = activeDb
    .query<
      {
        id: string;
        backend: string | null;
        backend_id: string | null;
      },
      [string]
    >(
      "SELECT id, backend, backend_id FROM folders WHERE id = ?",
    )
    .get(folderId);
  if (!row) return null;
  if (row.backend !== "restic" || !row.backend_id) return null;
  const cfg = resolveFolderResticConfig(activeDb, {
    id: row.id,
    backend: row.backend,
    backendId: row.backend_id,
  });
  if (!cfg) return null;
  return {
    backendId: cfg.backendId,
    repository: cfg.repository,
    password: cfg.password,
  };
}

async function runResticLs(
  snapshot: string,
  pathPrefix: string,
  ctx: FolderListingContext,
  runner: ResticSpawnFn = activeRunner,
): Promise<ResticSpawnResult> {
  return runner({
    args: resticLsArgs(snapshot, pathPrefix, ctx.repository),
    env: { RESTIC_PASSWORD: ctx.password },
  });
}

// ---------- routes -------------------------------------------------------

export const folderSnapshotsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/folders/:id/snapshots",
    ({ params, set }) => {
      const folderId = params.id;
      // 404 BEFORE the folder-kind check so a typo'd id is "not found",
      // not "no history" — consistent with the rest of /folders/*.
      const folderRow = activeDb
        .query<{ id: string }, [string]>(
          "SELECT id FROM folders WHERE id = ?",
        )
        .get(folderId);
      if (!folderRow) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      // Non-restic folders return an empty history (per LAMA-259 spec,
      // NOT a 409) so the slider can hide itself transparently. The
      // folder kind check is intentionally cheap — we don't hit
      // backends at all for non-restic folders.
      const isResticKind = activeDb
        .query<{ kind: string | null }, [string]>(
          "SELECT b.kind AS kind FROM folders f LEFT JOIN backends b ON b.id = f.backend_id WHERE f.id = ?",
        )
        .get(folderId);
      if (isResticKind?.kind !== "restic") {
        const empty: FolderSnapshotsResponse = { snapshots: [] };
        return empty;
      }
      const rows = activeDb
        .query<ResticSnapshotRow, [string]>(
          `SELECT snapshot_id, timestamp, host_id, paths
             FROM restic_snapshots
            WHERE folder_id = ?
            ORDER BY timestamp DESC`,
        )
        .all(folderId);
      const response: FolderSnapshotsResponse = {
        snapshots: rows.map(rowToFolderSnapshot),
      };
      return response;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "List folder-scoped restic snapshots for the time-travel slider",
        tags: ["Data Browser"],
        responses: {
          200: { description: "Snapshot list (empty for non-restic folders)" },
          404: { description: "Folder not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/folders/:id/snapshots/:snapshotId/files",
    async ({ params, query, set }) => {
      const folderId = params.id;
      const snapshotId = params.snapshotId;
      const pathPrefix = (query.path ?? "/").trim();
      const safePath = pathPrefix === "" ? "/" : pathPrefix;
      const limit = clampFilesLimit(query.limit);

      const folderRow = activeDb
        .query<
          { id: string; backend: string | null; backend_id: string | null },
          [string]
        >(
          "SELECT id, backend, backend_id FROM folders WHERE id = ?",
        )
        .get(folderId);
      if (!folderRow) {
        set.status = 404;
        return { error: "Folder not found" };
      }
      const ctx = resolveContextForFolder(folderId);
      if (!ctx) {
        set.status = 409;
        return {
          error:
            "folder is not a restic folder (missing repository or password)",
        };
      }
      // Defense-in-depth: the (folder, snapshot) tuple is the actual
      // access boundary. We don't strictly need this row to invoke
      // restic (restic will reject unknown snapshot ids with exit code
      // 1), but rejecting an unknown tuple up front means we never pass
      // caller-controlled snapshot ids to a real restic process in the
      // 404 case. Without this row, the live repository is the only
      // gate, and a stale snapshot id from a previous restic backend
      // would 502 with restic's raw stderr.
      const knownSnapshot = activeDb
        .query<{ snapshot_id: string }, [string, string]>(
          "SELECT snapshot_id FROM restic_snapshots WHERE folder_id = ? AND snapshot_id = ? LIMIT 1",
        )
        .get(folderId, snapshotId);
      if (!knownSnapshot) {
        set.status = 404;
        return { error: "Snapshot not found for this folder" };
      }

      const result = await runResticLs(snapshotId, safePath, ctx);
      if (result.code !== 0) {
        // LAMA-226: never echo raw stderr to the client. Log it
        // server-side (for the operator) and return a scrubbed summary.
        console.error(
          `[snapshots] restic ls failed for folder ${folderId} snapshot ${snapshotId}: ${result.stderr.trim()}`,
        );
        set.status = 502;
        return {
          error: scrubFailureSummary("ls", result.code),
        };
      }
      return resticLsResponse(
        result.stdout,
        safePath,
        snapshotId,
        folderId,
        limit,
      );
    },
    {
      params: t.Object({ id: t.String(), snapshotId: t.String() }),
      query: t.Object({
        path: t.Optional(t.String()),
        limit: t.Optional(
          t.Union([t.Number(), t.String()]),
        ),
      }),
      detail: {
        summary: "List files inside a folder's restic snapshot at a given path",
        tags: ["Data Browser"],
        responses: {
          200: { description: "Directory listing (one level)" },
          400: { description: "Invalid input" },
          404: { description: "Folder or snapshot not found" },
          409: { description: "Folder is not a restic folder" },
          502: { description: "restic invocation failed (scrubbed)" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
