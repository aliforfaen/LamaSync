# Handoff — `--help`/`-h` for `lamasyncd` + `lamasync-server`, reject unknown flags

**Date:** 2026-08-14
**Source:** Multica LAMA-242 ("`--help` cli helper command"; status `todo`). The
issue body is the contract; this doc grounds it in the current tree and locks the
decisions so you don't re-decide. If anything here conflicts with the issue body,
the issue wins — flag the drift in your PR notes.

**Status check (2026-08-14, verified against the tree):**

- `packages/tui/src/index.ts` **already** handles `--help`/`-h` (via
  `looksLikeCli` → `runCli` top-level help, LAMA-229). **Do not touch the
  TUI/CLI binary — it's done.**
- `packages/daemon/src/index.ts` handles only `--version`/`-V`. Everything else —
  including `--help`, `-h`, and any unknown flag — falls through to `main()`,
  which **boots the daemon**. Bug: `lamasyncd -h` starts a second daemon that
  fights the systemd-owned instance over the Unix socket.
- `packages/server/src/index.ts` handles only `--version`/`-V`. `lamasync-server
  --help` (and any unknown flag) **boots the server**.

## Mission

Add a classic `--help`/`-h` to the two binaries that lack it, and stop unknown
flags from silently booting a long-running process. Two binaries, both tiny.

## Maintainer decisions (locked — follow, do not re-decide)

1. **Scope = `lamasyncd` + `lamasync-server` only.** The `lamasync`/`lamasync-tui`
   binary already has help (LAMA-229). Do not modify it.
2. **`--help`/`-h` prints usage to stdout, exits 0.**
3. **Unknown flags print usage to stderr, exit 2** (usage error), instead of
   booting. Only tokens beginning with `-` are flags; bare tokens (e.g. `skill`
   after `--update`, the `--mount` value) are **not** flags and keep existing
   handling.
4. **Behavior for every existing flag must not change.** The tables below are
   authoritative — reproduce them exactly.
5. **Usage text lives in a new, pure, exported function** so it's unit-testable
   without importing the entry point. Importing `server/src/index.ts` **starts
   the server** (it calls `app.listen` at module scope), so never import it from
   a test. Suggested files: `packages/daemon/src/usage.ts` (export `daemonUsage()`)
   and `packages/server/src/usage.ts` (export `serverUsage()`), each returning a
   string. `import { VERSION } from "@lamasync/core"` for the version line.

## Flag surface (authoritative)

### `lamasyncd` — `packages/daemon/src/index.ts` (the `import.meta.main` block at the bottom)

| Invocation | Behavior today | After this change |
|---|---|---|
| `lamasyncd` (no args) | boots daemon (`main()`) | **UNCHANGED** |
| `lamasyncd --version` / `-V` | print `lamasyncd <VERSION>`, exit 0 | **UNCHANGED** |
| `lamasyncd --help` / `-h` | boots daemon (bug) | print `daemonUsage()` to stdout, exit 0 |
| `lamasyncd --check-update` | check for newer release via server proxy | **UNCHANGED** |
| `lamasyncd --update` | self-update the binary | **UNCHANGED** |
| `lamasyncd --update skill` | refresh agent skill bundle | **UNCHANGED** |
| `lamasyncd --mount <folderId>` / `--mount=<folderId>` | mount folder in foreground | **UNCHANGED** |
| `lamasyncd --bogus` | boots daemon (bug) | print `daemonUsage()` to stderr, exit 2 |

Known flag tokens: `--version`, `-V`, `--help`, `-h`, `--check-update`,
`--update`, `--mount`, plus any token matching `--mount=*`.

### `lamasync-server` — `packages/server/src/index.ts`

| Invocation | Behavior today | After this change |
|---|---|---|
| `lamasync-server` (no args) | boots server | **UNCHANGED** |
| `lamasync-server --version` / `-V` | print `lamasync-server <VERSION>`, exit 0 | **UNCHANGED** |
| `lamasync-server --help` / `-h` | boots server (bug) | print `serverUsage()` to stdout, exit 0 |
| `lamasync-server --bogus` | boots server (bug) | print `serverUsage()` to stderr, exit 2 |

Known flag tokens: `--version`, `-V`, `--help`, `-h`.

## Work

### 1. `packages/daemon/src/usage.ts` (new)

Export a `daemonUsage(): string` function returning a help block that contains
**at least**:

- a version line, e.g. `lamasyncd v<VERSION>` (`VERSION` from `@lamasync/core`
  is `0.3.1` — no leading `v`, so write it as `v${VERSION}` or plain `${VERSION}`,
  your call — just be consistent with the binary's existing `--version` output,
  which is `lamasyncd <VERSION>`);
- a `Usage:` section listing the invocations: bare run, `--mount <folderId>`,
  `--check-update`, `--update`, `--update skill`;
- a `Flags:` section with `-h, --help` and `-V, --version` (one-line description each);
- an exit-codes line: `0 ok, 1 runtime error, 2 usage error`.

Also export the known-flag set so the entry point and the unknown-flag guard share
one source of truth:

```ts
export const DAEMON_KNOWN_FLAGS = new Set([
  "--version", "-V", "--help", "-h",
  "--check-update", "--update", "--mount",
]);
```

### 2. `packages/server/src/usage.ts` (new)

Export `serverUsage(): string` with the same shape but the server's flag surface
(`--version`/`-V` only). Note in the text that configuration comes from
environment variables (`LAMASYNC_API_KEY`, `PORT`, `LAMASYNC_GITHUB_TOKEN`, …).
Export `SERVER_KNOWN_FLAGS = new Set(["--version", "-V", "--help", "-h"])`.

### 3. Wire into the daemon entry point

At the top of the `import.meta.main` block in `packages/daemon/src/index.ts`,
insert — **before** the existing `--version` check — help and unknown-flag
handling. Leave the existing `--check-update` / `--update skill` / `--update` /
`--mount` / `else main()` chain exactly as it is:

```ts
import { daemonUsage, DAEMON_KNOWN_FLAGS } from "./usage.ts";

// inside `if (import.meta.main) {`
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(daemonUsage());
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log(`lamasyncd ${VERSION}`);
  process.exit(0);
}

// Unknown-flag guard: reject any `-`-prefixed token that isn't known.
// `--mount=<id>` and bare positionals (`skill`, the `--mount` value) pass.
if (args.some((a) => a.startsWith("-") && !a.startsWith("--mount=") && !DAEMON_KNOWN_FLAGS.has(a))) {
  console.error(daemonUsage());
  process.exit(2);
}
```

Keep the rest of the block verbatim. The existing `--version` check can be folded
into the above (remove the old standalone one) — just don't change its output.

### 4. Wire into the server entry point

Same pattern at the top of `packages/server/src/index.ts`, right after the
`--version` check (which stays):

```ts
import { serverUsage, SERVER_KNOWN_FLAGS } from "./usage.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(serverUsage());
  process.exit(0);
}

if (args.some((a) => a.startsWith("-") && !SERVER_KNOWN_FLAGS.has(a))) {
  console.error(serverUsage());
  process.exit(2);
}
```

The server's `--version` check already exists (`lamasync-server ${VERSION}`); do
not change it.

## Tests

The usage strings and known-flag sets are pure — unit-test them:

- `packages/daemon/src/usage.test.ts`: assert `daemonUsage()` contains
  `--help`, `-h`, `--version`, `--check-update`, `--update`, `--mount`, and
  `${VERSION}`; assert `DAEMON_KNOWN_FLAGS` has the 7 tokens and does **not**
  include `--bogus`.
- `packages/server/src/usage.test.ts`: same, for `serverUsage()` and
  `SERVER_KNOWN_FLAGS`.

The dispatch itself (help/version/unknown → process exit) lives in the top-level
`import.meta.main` block and is **not** unit-tested (importing the server entry
point would start a server). Cover it with the manual commands below.

## Done when

- `bun x tsc --noEmit` — clean.
- `bun test` — green (existing 549 pass + your new usage tests; 1 pre-existing skip).
- Manual verification below all behave as listed.

## Manual verification

Run from the repo root (`bun run build` first if you want to test the compiled
binaries; `bun run packages/daemon/src/index.ts --help`-style runs also work for
the source form — use `bun packages/daemon/src/index.ts --help`).

```bash
lamasyncd --help; echo "exit=$?"            # usage on stdout, exit 0
lamasyncd -h; echo "exit=$?"                # same
lamasyncd --bogus; echo "exit=$?"           # usage on stderr, exit 2
lamasyncd --version                         # "lamasyncd 0.3.1" (unchanged)

lamasync-server --help; echo "exit=$?"      # usage on stdout, exit 0
lamasync-server -h; echo "exit=$?"          # same
lamasync-server --bogus; echo "exit=$?"     # usage on stderr, exit 2
lamasync-server --version                   # "lamasync-server 0.3.1" (unchanged)
```

Do **not** actually run a bare `lamasyncd` to verify it still boots — a second
instance fights the systemd-owned daemon over the socket. Confirm the bare path
still reaches `main()` by code review (the `else` branch is untouched).

## Out of scope (do not do)

- No changes to `packages/tui/**` — the `lamasync` CLI already has help.
- No changes to how `--check-update`, `--update`, `--update skill`, `--mount`,
  or bare-boot behave.
- No new flags, no `--json`, no env-var parsing beyond what exists.
