# Handoff — product-finish endgame: CLI fallback, remaining work, closing scope (2026-08-26)

Owner approved the **split-by-surface** CLI fallback decision (below). This
doc is the work order for finishing `feature/product-finish`. Session
contract unchanged: one commit per item, gates after each (`tsc`,
`build:web-ui`, `bun test`, drift `--strict`), plus the new **server-boot
smoke check** before any deploy:

```bash
LAMASYNC_API_KEY=x LAMASYNC_DATA_DIR=/tmp/ls-boot LAMASYNC_BACKUP_DIR=/tmp/ls-boot \
  timeout 8 bun run packages/server/src/index.ts   # must print "listening"
```
(Lesson from 2026-08-26: unit tests never boot Elysia; route-param conflicts
only surface at startup.)

## 1. LAMA-fallback — CLI split-by-surface behavior (owner-approved)

**Decision:** interactive and non-interactive surfaces behave differently
when no `~/.config/lamasync/client.toml` exists.

| Surface | Behavior |
|---|---|
| Bare `lamasync` + TTY (interactive shell) | Keep current friendly default (localhost/dev-key) WITH the loud fake-key banner shipped in LAMA-254 |
| Any explicit subcommand (`lamasync folders list`, `lamasyncd ...`) | **Refuse fast**: exit code 3, message to stderr: "No client.toml found at <path> — run bare 'lamasync' once to connect to your fleet" |

Implementation notes:
- Files involved: `packages/tui/src/cli/cli-fallback.ts`, `cli/client.ts`,
  `cli/doctor.ts` (its advice changes), `cli/dispatch.ts` / `output.ts`
  (exit-code path). The refusal must fire BEFORE any network attempt.
- `lamasync doctor` should still run without config (diagnosing IS its job)
  — exempt it explicitly.
- Update `packages/agent-skill/reference/cli.md` exit-code table + the
  troubleshooting section that mentions the fake-key default.
- Tests: dispatch with no config file → exit 3 + message for ≥3 different
  subcommands; bare-TTY default path unchanged; doctor exemption.

## 2. Remaining loose ends (small)

1. **Deploy batch 2 to prod**: branch is ~10 commits ahead of master →
   merge PR (new one or direct), wait for CI docker job, `update.sh` on the
   LXC, boot-verify health + `/api/v1/demo`.
2. **DataBrowser wide-table overflow ~375px** (deferred from P-A): scroll
   wrapper + `min-width` on `table.data`; also the off-canvas rail's
   negative-translate inflating `scrollWidth`.
3. **HostDetail heading wording** ("Assigned folders (N)") — terminology
   says assignments disappear from user-facing copy; needs a copy decision,
   not just a rename (the editor flow still uses assignments internally).
4. **Per-host restic config overrides** deferred by LAMA-259's server work
   (`resolveFolderResticConfig` is folder-level only).

## 3. Closing scope — my two cents on the remaining flourish issues

### LAMA-260 File view inside synced folders — DO, but skip the library spike
The browse surface already exists and is battle-tested this cycle: S3
browser (streaming download cap, 404 shapes) + restic snapshot browser from
LAMA-259. What's missing is content preview (images/text) and upload. My
recommendation: **justify custom minimal** — the issue allows exactly that.
A react file-viewer library adds bundle weight to a deliberately lean SPA
(~430 kB total) for what is `<img>` + `<pre>` under ~200 lines against
endpoints we already have. Scope: image preview (blob URL via existing
download endpoint), text preview (<256 KB cap), upload button (one additive
route reusing auth), download (exists). One agent-session, web+server.

### LAMA-262 Pairing flow (code/QR) — DO LAST of the three, it touches bootstrap
Best UX win left in the backlog, moderate scope, mostly code: server issues
short-lived pairing token + human code (`lama-72B4-9PQ1`), web shows code +
QR, daemon exchanges code for real key. Two cautions:
1. **Sequence after the CLI-fallback item** — `lamasync register` writes
   `client.toml`, so it must land on top of the new refusal semantics, not
   beside them.
2. QR needs an encoding choice: pull a tiny dependency (e.g. `qrcode`)
   or render SVG server-side and ship it as markup. Prefer server-side SVG
   generation — keeps the SPA dependency-free per house style.
Keep the manual-key fallback for headless/SSH exactly as the issue says;
it's also your escape hatch if pairing breaks mid-demo.

### LAMA-274 Personality system beyond one hop — FOLD INTO A FUTURE POLISH RUN, don't standalone
LAMA-265 already delivered the core tastefully (llama glyph, confetti).
What's left per the issue is a *design-system* pass: loading/error/empty
llama variants + fleece-metaphor copy. My two cents: extend `Llama.tsx`
with 2–3 pose variants and wire them into existing EmptyState/error slots
in the NEXT polish run — do not build a "personality token system"; that's
Clippy territory for a fleet utility. Cap it: no lama in error paths that
carry real failure detail, keep copy glossary-first.

## Suggested order

1. CLI fallback (#1) — small, unblocks 262
2. Deploy batch 2 + these fixes to prod (#2.1)
3. LAMA-260 custom-minimal implementation
4. LAMA-262 pairing flow
5. Next polish run absorbs LAMA-274 + leftover #2/#3
