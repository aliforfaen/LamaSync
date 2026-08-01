# Handoff — Command Center v1, Batch 5 (LAMA-202)

**Audience:** implementing agent. Read `AGENTS.md` first (conventions), then
`docs/handoff/command-center-batch1.md` §"Ground rules" (same rules apply).
**Epic:** LAMA-183. Batches 1–4 merged. You build on the theme tokens +
icons (LAMA-201), the Command Center nav structure, and the folders table
(with its S3 fields).

## Decisions already made (do not revisit)

- **100% read-only.** NO mutation endpoint ships in this issue. No
  copy/move/rename/delete anywhere, even disabled.
- **S3 listing is a hand-rolled SigV4 client** (`fetch` + AWS SigV4
  ListObjectsV2) — there is no S3 SDK in the dependency tree and we don't add
  one. Keep it small, focused on listing with a `/` delimiter (directory
  semantics), tested against the published AWS SigV4 test vector.
- **Local root = `LAMASYNC_BACKUP_DIR`** (`/backups` default) — the
  server-side storage directory. Show which folder/host each top-level entry
  maps to where derivable (folder names match `folders.name`; ownership of
  nested files isn't reliably derivable — show "folder: <name>" when the
  top-level dir matches a known folder name, else "—").
- **Restic metadata reuses the existing snapshots API** (`GET
  /api/v1/restic/snapshots`) — no new snapshot endpoint. The browser UI has a
  Restic tab that renders it.
- **Strict path validation, no traversal:** reject any input path containing
  `..` segments, absolute paths, or empty segments; canonicalize; for local
  browsing also resolve symlinks (`realpath`) and verify the result stays
  under the configured root.

## Task — read-only Data Browser foundation

### 1. Server — shared path safety — new `packages/server/src/browse-paths.ts`

- `resolveBrowsePath(root: string, input: string): string | null` — reject
  when `input` contains `..` or `\0` or is absolute; join `root` + input;
  `realpath` the result (catch ENOENT → null); return the resolved path only
  when it starts with `root + sep`. `null` → caller returns 400.
- Unit tests `browse-paths.test.ts`: traversal attempts (`..`,
  `a/../../etc`), absolute paths, root itself, nested valid paths, missing
  dirs.

### 2. Server — S3 listing — new `packages/server/src/s3-list.ts`

- `listS3Objects(folder: Folder, prefix: string, limit: number)` →
  `Promise<S3Listing>` where `S3Listing = { entries: S3Entry[] }` and
  `S3Entry = { name, type: "dir" | "file", size, lastModified }`:
  - `name` is the key segment relative to the current prefix; `type` is
    `dir` when the key ends with `/` (ListObjectsV2 `CommonPrefixes` are
    dirs; `Contents` are files).
  - SigV4: implement `signRequest(method, host, path, query, payloadHash,
    creds, region, service="s3", now)` per the AWS signature spec; use
    `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` and query-string auth
    (`X-Amz-Date`, `X-Amz-Security-Token` only if creds provide a token —
    they won't; keep the fields optional). Creds from the folder's
    `s3Endpoint`/`s3AccessKeyId`/`s3SecretAccessKey`/`s3Region`.
  - ListObjectsV2 call: `GET {endpoint}/{bucket}?list-type=2&prefix=…&delimiter=/&max-keys={limit}`
    (prefix = the current browse path, guaranteed not to contain `..`);
    parse XML (use Bun's built-in XML parser or a tiny regex-free DOM —
    `new DOMParser` isn't in Bun; use `Bun.XMLParser` or manual parsing of
    the known shape — pick whichever compiles cleanly and test it).
  - Errors: unreachable endpoint / 4xx → throw a typed error the route maps
    to 502 with a message; never return partial garbage.
- Tests `s3-list.test.ts`:
  - SigV4 canonical request + signature against the **AWS published test
    vector** (the `get-vanilla-query` case from the AWS docs: expected
    signature known) — hardcode the expected values.
  - XML parse of a representative ListObjectsV2 response (fixture string) →
    entries with correct name/type/size.
  - `..` prefix rejection (belt + braces at the client level).

### 3. Server — routes — new `packages/server/src/routes/browse.ts`

All under `prefix: "/api/v1"`, tag `["Data Browser"]`, every route has a
Swagger `detail` block. Response shape for all three:

```ts
interface BrowseResponse {
  backend: "local" | "s3";
  path: string;            // the canonical path/prefix browsed
  entries: BrowseEntry[];  // { name, type: "dir"|"file", size, mtime, folderId? }
}
```

- `GET /browse/local?path=` — root is `LAMASYNC_BACKUP_DIR`; list the dir at
  `resolveBrowsePath(root, path)`; entries: name, type (dir/file), size,
  mtime (stat); `folderId` set when the top-level dir name matches a folder
  name (`folders.name`) — for the root listing only. Missing path → list the
  root.
- `GET /browse/s3?folderId=&path=` — load the folder (404 if unknown; 400 if
  its `backend !== 's3'` or creds missing); call `listS3Objects` with
  `path` as the prefix (default ""); map entries (mtime from
  `LastModified`, size, `folderId` = the folder id).
- `GET /browse/restic` — proxy the existing `listResticSnapshots` rows
  (folderId, hostId, snapshotId, timestamp, paths, sizeBytes) so the UI gets
  one consistent source. Read-only.
- Path validation failures → 400 `{error: "invalid path"}`. Server-side
  errors (S3 unreachable) → 502.
- Route tests `browse.test.ts` (pattern: `__setDb` seam; for the local route
  create a temp dir fixture under the test's `LAMASYNC_BACKUP_DIR`):
  traversal → 400; root listing works; s3 route 404s unknown folder / 400s
  non-s3 folder; s3 happy path with a mocked `listS3Objects` (inject a
  module seam like the `__setDb` pattern).

### 4. Web UI

- `packages/web-ui/src/api.ts`: `browseLocal(path)`, `browseS3(folderId,
  path)`, `browseRestic()` (typed against the core types + BrowseResponse).
- New `packages/web-ui/src/pages/DataBrowser.tsx` — route `/data`:
  - Backend tabs: **Local** (server backup dir), **S3** (folder picker of
    `backend==='s3'` folders, then browse), **Restic** (metadata table).
  - Local/S3: breadcrumb navigation (root, click dirs to descend), entries
    table (name, type icon, size, modified, owning folder where known),
    ".. / parent" entry, back/up navigation. **No action buttons of any
    kind** — read-only is a visible design constraint (a muted footer note
    "read-only view" is fine).
  - Restic: table of snapshots (folder, host, time, paths, size).
  - Use theme tokens; new CSS classes under `packages/web-ui/src/index.css`
    with `var(--…)` only; both themes legible.
  - Error/empty states via the existing `.error` / `.empty-row` patterns.
- `packages/web-ui/src/App.tsx`: add `/data` route. `Nav.tsx`: add a "Data"
  nav item (use `IconStorage`).

### 5. Docs

- `packages/agent-skill/lamasync-server.md`: add the three browse routes to
  the endpoint table (note the read-only guarantee).

## Scope (out)

- copy/move/rename/delete (Phase 2), backend migration jobs (Phase 3), S3
  upload/object actions, recursive size totals, auth-scoped roots.

## Acceptance criteria (from the issue)

- All three source types browsable from one UI.
- 100% read-only: no mutation endpoint ships.

## Verify before done

`bun x tsc --noEmit`, `bun run build:web-ui`, `bun test` (existing 259 pass
/ 1 skip / 0 fail + your new tests; note batch 4 may have landed before you —
re-run whatever the suite says). Do NOT commit.

## Report when done

Files changed by package, verify results, deviations from this doc.
