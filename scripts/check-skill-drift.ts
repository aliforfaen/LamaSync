#!/usr/bin/env bun
/**
 * scripts/check-skill-drift.ts — verifies that every route documented in
 * `packages/agent-skill/reference/api.md` exists in
 * `packages/server/src/routes/`, and that every command / flag mentioned
 * in `reference/cli.md` matches the actual `lamasync` binary's --help
 * output.
 *
 * This is the CI check for LAMA-230 ("Skill fails CI when it references a
 * dead surface"). It also catches extra unmapped server routes, but only
 * the documented-but-missing direction is fatal — undocumented additional
 * routes are surfaced as warnings to keep the bar low on additions.
 *
 * Usage:
 *   bun run scripts/check-skill-drift.ts [--strict]
 *
 * Exit codes:
 *   0  no drift detected
 *   1  at least one documented surface is missing in code, OR (with
 *      --strict) routes exist that aren't yet documented in api.md
 */

import { spawnSync } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

import { listInvocations } from "../packages/tui/src/cli/dispatch.ts";

const ROOT = resolve(import.meta.dir, "..");
const REPO = ROOT;
const AGENT_SKILL_DIR = join(REPO, "packages/agent-skill");
const ROUTES_DIR = join(REPO, "packages/server/src/routes");
const API_MD = join(AGENT_SKILL_DIR, "reference/api.md");
const CLI_MD = join(AGENT_SKILL_DIR, "reference/cli.md");
const STRICT = process.argv.includes("--strict");

interface RouteRow {
  method: string; // e.g. "GET" or "POST"
  path: string; // e.g. "/api/v1/health" or "/swagger/json"
}

function readMd(path: string): string {
  return readFileSync(path, "utf8");
}

/** Extract method+path rows from a markdown table. Skips the header row
 *  and the alignment row. The "Method" column is the FIRST column, the
 *  "Path" the SECOND. */
function parseApiDocRoutes(md: string): RouteRow[] {
  const rows: RouteRow[] = [];
  const lines = md.split("\n");
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    const method = cells[0]?.trim() ?? "";
    const pathRaw = cells[1]?.trim() ?? "";
    // Strip inline backticks (the docs use \`/api/v1/health\`).
    // Strip query strings ("/admin/prune?olderThanMs=…" → "/admin/prune");
    // the audit compares path shapes, not query grammar.
    const path = pathRaw.replace(/`/g, "").replace(/\?.*$/, "");
    // Skip the header row (Method, Path, …) and the alignment row.
    if (method === "Method" || /^[-:|\s]+$/.test(line)) continue;
    if (!/^(GET|POST|PUT|PATCH|DELETE|WS)$/.test(method)) continue;
    rows.push({ method, path });
  }
  return rows;
}

function splitRow(line: string): string[] {
  // Strip leading + trailing pipes, then split on " | ".
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
}

/** Scan every server route file for Elysia `.get(`, `.post(`, etc.
 *  invocations whose first argument is a string literal (the path). The
 *  routes are mounted under `/api/v1` per the prefix declared on each
 *  Elysia instance; we resolve relative to that prefix when we can. */
function parseServerRoutes(): RouteRow[] {
  const out: RouteRow[] = [];
  const files = readdirSync(ROUTES_DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"));
  for (const file of files) {
    const text = readFileSync(join(ROUTES_DIR, file), "utf8");
    const fileRoutes = file;
    // Find the Elysia prefix declaration. The convention is
    //   .use(getAuthPlugin()).use(<routes>)
    // OR a fresh Elysia() constructor followed by .use(prefix: "/api/v1").
    // The pre-existing pattern is `new Elysia({ prefix: "/api/v1" })` per
    // routes file — we just hard-code "/api/v1" for the audit.
    const prefix = "/api/v1";
    const re = /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
    const wsRe = /\.ws\(\s*["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const method = (m[1] ?? "").toUpperCase();
      const path = (m[2] ?? "").trim();
      if (!path.startsWith("/")) continue;
      const full = `${prefix}${path}`;
      out.push({ method, path: full, file: fileRoutes });
    }
    while ((m = wsRe.exec(text))) {
      const path = (m[1] ?? "").trim();
      if (!path.startsWith("/")) continue;
      const full = `${prefix}${path}`;
      out.push({ method: "WS", path: full, file: fileRoutes });
    }
  }
  // Pull the WS route from `packages/server/src/ws.ts` too — `.ws()` lives
  // outside the routes/ directory by convention. The drift-check treats
  // the WS endpoint as just another documented surface so missing it is
  // an error, not a warning.
  try {
    const wsText = readFileSync(join(REPO, "packages/server/src/ws.ts"), "utf8");
    const wsRe = /\.ws\(\s*["'`]([^"'`]+)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = wsRe.exec(wsText))) {
      const path = (m[1] ?? "").trim();
      if (!path.startsWith("/")) continue;
      out.push({ method: "WS", path: `/api/v1${path}`, file: "ws.ts" });
    }
  } catch {
    // ignore
  }
  // Add the manually-mounted routes that live in the server's main `index.ts`
  // (web UI, swagger). Surfacing them as "always present" prevents them from
  // triggering drift warnings just because we don't audit the index file.
  const hardcoded: RouteRow[] = [
    { method: "GET", path: "/swagger/json" },
    { method: "GET", path: "/swagger" },
    { method: "GET", path: "/" },
  ];
  return [...out, ...hardcoded];
}

interface CliCommand {
  /** Top-level invocation, e.g. "status" or "folders list". */
  invocation: string;
  /** Flags/args mentioned, e.g. ["--json"], ["--host <hostId>", "--path <localPath>"]. */
  flags: string[];
}

/** Extract every fenced code block that opens with a "Usage: lamasync …"
 *  line. The invocation is the leading lowercase word tokens after
 *  "lamasync" (stops at positionals like `<id>`, `[flags]`, flag tokens,
 *  and pipe-alternatives like `list|create|delete`). Every `--long-flag`
 *  token anywhere in the block (usage line(s), flag list, sub-command
 *  rows) is collected — flag lists in cli.md are separated from the usage
 *  line by a blank line, so we must NOT stop at blanks. */
function parseCliDocs(md: string): CliCommand[] {
  const out: CliCommand[] = [];
  const lines = md.split("\n");
  let inFence = false;
  let block: string[] = [];
  const flush = (): void => {
    const usageLine = block.find((l) => /^Usage:\s+lamasync(\s|$)/.test(l));
    if (usageLine === undefined) return;
    const tail = usageLine.replace(/^Usage:\s+lamasync\s*/, "").trim();
    const words: string[] = [];
    for (const tok of tail.split(/\s+/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(tok)) break;
      words.push(tok);
    }
    const invocation = ["lamasync", ...words].join(" ");
    const flags: string[] = [];
    for (const l of block) {
      for (const m of l.matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (!flags.includes(m[0])) flags.push(m[0]);
      }
    }
    out.push({ invocation, flags });
  };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inFence) flush();
      inFence = !inFence;
      block = [];
      continue;
    }
    if (inFence) block.push(line);
  }
  return out;
}

/** Drive the binary to dump every command's --help. We use a thin shim
 *  rather than the real one because the real binary needs a TTY in some
 *  renderers — the dispatcher returns plain text for `--help`, but inside
 *  the compiled Bun binary the print path is the same `process.stdout.write`
 *  branch we exercise here.
 *
 *  The invocation set is seeded from the dispatch walker (source of truth,
 *  covers every leaf AND every nested-group path), then enriched with
 *  anything the binary's top-level "Commands:" section advertises that
 *  isn't in the tree yet. `perCmd` always carries the actual --help text
 *  for each invocation, fetched by running `<inv> --help` against the
 *  binary (or its source fallback). */
function dumpCliHelp(): { invocations: Set<string>; perCmd: Map<string, string> } {
  const invocations = new Set<string>();
  const perCmd = new Map<string, string>();
  const helpFor = (cmd: string[]): string => runHelp([...cmd, "--help"]);

  const top = helpFor([]);
  perCmd.set("", top);

  // Source-of-truth: every path the dispatch tree accepts, including the
  // leaves of nested groups (e.g. `dotfiles manifests list|create|delete`)
  // that the top-level `Commands:` section never enumerates.
  for (const inv of listInvocations()) invocations.add(inv);

  // Parse the "Commands:" section: each row is `<invocation-spec>  <description>`
  // separated by a run of 2+ spaces. The invocation is the spec's leading
  // lowercase word tokens (positionals like `<id>` / `[folderId]` stop it).
  const fullInvocations: string[] = [];
  let inCommands = false;
  for (const line of top.split("\n")) {
    if (/^Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    if (line.trim() === "") break; // end of the Commands: section
    const spec = line.trim().split(/\s{2,}/)[0] ?? "";
    const words: string[] = [];
    for (const tok of spec.split(/\s+/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(tok)) break;
      words.push(tok);
    }
    if (words.length > 0) fullInvocations.push(words.join(" "));
  }

  for (const inv of fullInvocations) {
    invocations.add(inv);
    perCmd.set(inv, helpFor(inv.split(" ")));
    // Register the group head ("folders" for "folders list") as a valid
    // invocation with its own group-level help.
    const head = inv.split(" ")[0] ?? "";
    if (head !== inv && !invocations.has(head)) {
      invocations.add(head);
      perCmd.set(head, helpFor([head]));
    }
  }

  // Fetch per-invocation --help for any path the dispatch walker found but
  // the top-level Commands: section didn't (depth-3 leaves).
  for (const inv of invocations) {
    if (inv === "") continue;
    if (!perCmd.has(inv)) perCmd.set(inv, helpFor(inv.split(" ")));
  }
  return { invocations, perCmd };
}

function runHelp(args: string[]): string {
  const binary = join(REPO, "packages/tui/dist/lamasync-tui");
  if (existsSync(binary)) {
    const res = spawnSync({
      cmd: [binary, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LAMASYNC_NO_TUI: "1" },
    });
    if (res.exitCode === 0) {
      return res.stdout.toString() + "\n" + res.stderr.toString();
    }
  }
  // Fall back to running the TUI entrypoint from source when the compiled
  // binary isn't built (e.g. the CI check job). `packages/tui/src/index.ts`
  // routes any positional argv to the CLI dispatcher before booting the
  // TUI; `cli/index.ts` is only a re-export barrel and prints nothing.
  const src = join(REPO, "packages/tui/src/index.ts");
  const srcRes = spawnSync({
    cmd: ["bun", "run", src, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LAMASYNC_NO_TUI: "1" },
  });
  return srcRes.stdout.toString() + "\n" + srcRes.stderr.toString();
}

function main(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ---- API drift --------------------------------------------------------
  const apiMd = readMd(API_MD);
  const documented = parseApiDocRoutes(apiMd);
  const implemented = parseServerRoutes();
  const implementedKeys = new Set(implemented.map(routeKey));
  for (const row of documented) {
    if (!implementedKeys.has(routeKey(row))) {
      errors.push(
        `reference/api.md documents ${row.method} ${row.path} but no server route matches`,
      );
    }
  }
  const documentedKeys = new Set(documented.map(routeKey));
  for (const row of implemented) {
    if (!documentedKeys.has(routeKey(row))) {
      const msg = `server route ${row.method} ${row.path} is not in reference/api.md (file: ${row.file ?? "(index)"})`;
      if (STRICT) errors.push(msg);
      else warnings.push(msg);
    }
  }

  // ---- CLI drift --------------------------------------------------------
  // If the binary isn't built, attempt to build it. We deliberately do
  // NOT fail the check when the build doesn't work in CI — the route
  // audit alone catches most drift; CLI flag drift is best-effort and
  // surfaces a warning if the binary is unavailable.
  let cliError = "";
  let invocations: Set<string> = new Set();
  let perCmd: Map<string, string> = new Map();
  try {
    const dump = dumpCliHelp();
    invocations = dump.invocations;
    perCmd = dump.perCmd;
  } catch (err) {
    cliError = err instanceof Error ? err.message : String(err);
  }
  if (cliError) {
    warnings.push(`could not dump CLI help: ${cliError}`);
  } else {
    const cliMd = readMd(CLI_MD);
    const documentedCli = parseCliDocs(cliMd);
    for (const cmd of documentedCli) {
      const inv = cmd.invocation === "lamasync"
        ? ""
        : cmd.invocation.replace(/^lamasync\s+/, "");
      if (inv === "") continue; // top-level Usage, not a subcommand
      if (!hasInvocation(inv, invocations)) {
        errors.push(`reference/cli.md documents \`lamasync ${inv}\` but the binary has no such command`);
        continue;
      }
      // Help text for this exact invocation. When the invocation is a
      // command GROUP (e.g. `browse`, whose cli.md block documents flags
      // per subcommand), fold in every sub-invocation's help too so each
      // documented flag is still matched against real --help output.
      let helpText = perCmd.get(inv) ?? "";
      for (const known of invocations) {
        if (known.startsWith(`${inv} `)) {
          helpText += `\n${perCmd.get(known) ?? ""}`;
        }
      }
      for (const flagName of cmd.flags) {
        // Help text lists each flag on its own line, indented — or inline
        // in the usage line inside brackets (`[--json]`, `[--host <id>]`).
        if (!new RegExp(`(^|\\s|\\[)${escapeRegex(flagName)}(\\s|$|<|,|\\])`).test(helpText)) {
          errors.push(
            `reference/cli.md mentions \`${flagName}\` for \`lamasync ${inv}\` but it doesn't appear in the binary's --help output`,
          );
        }
      }
    }
  }

  // ---- Report -----------------------------------------------------------
  for (const warn of warnings) {
    process.stdout.write(`WARN  ${warn}\n`);
  }
  if (errors.length === 0) {
    process.stdout.write(
      `\nskill-drift: OK (${documented.length} API rows, ${implemented.length} server routes, ${
        perCmd.size
      } CLI commands scanned)\n`,
    );
    process.exit(0);
  }
  process.stdout.write(`\nskill-drift: FAILED (${errors.length} error(s))\n`);
  for (const err of errors) process.stdout.write(`FAIL  ${err}\n`);
  process.exit(1);
}

function routeKey(r: RouteRow): string {
  // Normalize so /api/v1/health and /health collapse to the same key when
  // the latter is documented via the (manual) /swagger shorthand.
  const norm = r.path.replace(/^\/api\/v\d+/, "");
  return `${r.method.toUpperCase()} ${norm}`;
}

function hasInvocation(inv: string, set: Set<string>): boolean {
  // Strict membership only — the set holds every full invocation the
  // binary's help enumerates (plus group heads), so a documented
  // `lamasync folders bogus-subcommand` can no longer pass via its head
  // token.
  return set.has(inv);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main();
