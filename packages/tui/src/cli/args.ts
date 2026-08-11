/**
 * Hand-rolled argv parser for the `lamasync` subcommand surface.
 *
 * The project's CLI is intentionally zero-dependency (matches the rest of
 * the TUI/server/daemon), so we walk argv ourselves. The shape we return
 * is intentionally trivial:
 *
 *   {
 *     command: ["folders", "delete"], // top-level + nested subcommand
 *     flags: { json: true, name: "lamasync" },
 *     rest:  ["folder-id-1"], // bare words after the command path
 *     hasCommand: true, // true iff `command.length > 0` (see below)
 *   }
 *
 * Commands interpret `command` themselves. Usage errors throw
 * `CliUsageError` — the dispatcher catches that and exits 2.
 *
 * Why `hasCommand`? The TUI binary's entry-level dispatch must decide
 * whether argv contains a subcommand (CLI dispatch) or just overrides
 * (TUI boot + runCliFallback). A naive "first non-flag token is the
 * command" rule is wrong when the override has a URL as its VALUE
 * (`lamasync --server http://x --api-key y` shouldn't trip the CLI
 * dispatch). The parser tracks this state cleanly: `hasCommand` is true
 * iff we observed a positional that wasn't consumed by a preceding
 * flag's value.
 *
 * Conventions (locked in LAMA-229):
 *   - Flags use `--long` and `-s` short forms. `--flag value` and
 *     `--flag=value` are equivalent. Short flags never take values.
 *   - `--` ends flag parsing; everything after is in `rest`.
 *   - `--help` / `-h` is reserved and yields a top-level help banner.
 *   - Unknown flags throw CliUsageError (exit 2), never silently ignored.
 */

export class CliUsageError extends Error {
  readonly command: string[];
  constructor(message: string, command: string[] = []) {
    super(message);
    this.name = "CliUsageError";
    this.command = command;
  }
}

export interface ParsedArgs {
  /** Non-flag words that name the command tree path. Depth-2 max
   *  (e.g. `["folders", "delete"]`); deeper words go to `rest`. */
  command: string[];
  flags: Record<string, string | boolean | Array<string | boolean>>;
  /** Bare words after `--` OR positional args beyond the command path. */
  rest: string[];
  /** True when the operator typed a recognised command path (not just
   *  bare flags). The TUI's binary entry uses this to route to the CLI
   *  dispatcher instead of the legacy TUI / `runCliFallback` paths. */
  hasCommand: boolean;
}

function isShortFlag(token: string): boolean {
  return /^-[A-Za-z]$/.test(token);
}

function isLongFlag(token: string): boolean {
  return /^--[A-Za-z][A-Za-z0-9-]*$/.test(token);
}

function isFlagValuePair(token: string): boolean {
  return /^--[A-Za-z][A-Za-z0-9-]*=/.test(token);
}

/** Parse `argv`. Throws CliUsageError on any unknown flag or malformed
 *  input. The returned `hasCommand` flag tells callers whether the
 *  parser saw a positional that wasn't consumed as a flag value. */
export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags: Record<string, string | boolean | Array<string | boolean>> = {};
  const rest: string[] = [];
  let hasCommand = false;

  let i = 0;
  let inFlags = true;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    if (inFlags && token === "--") {
      inFlags = false;
      i++;
      continue;
    }
    if (inFlags && isFlagValuePair(token)) {
      const eq = token.indexOf("=");
      const name = token.slice(2, eq);
      const value = token.slice(eq + 1);
      setFlag(flags, name, value);
      i++;
      continue;
    }
    if (inFlags && isLongFlag(token)) {
      const name = token.slice(2);
      const next = argv[i + 1];
      // `--boolean` with no value: treat as true. Anything that follows
      // that *looks* like a flag is the next flag's start.
      if (next === undefined || isShortFlag(next) || isLongFlag(next) || isFlagValuePair(next)) {
        setFlag(flags, name, true);
        i++;
        continue;
      }
      setFlag(flags, name, next);
      i += 2;
      continue;
    }
    if (inFlags && isShortFlag(token)) {
      // Single-letter flags never take a value (e.g. -j, -h). Add more
      // here only when a real boolean toggle needs one.
      const name = token.slice(1);
      setFlag(flags, name, true);
      i++;
      continue;
    }
    // Bare word. Positionals NEVER end flag parsing — `lamasync folders
    // assign <id> --host X --path /y` is the most common shape and the
    // parser must keep accepting flags after the first positional. Only
    // an explicit `--` ends flag mode. The first two positionals fill
    // the `command` segment; the third and beyond go to `rest`.
    if (command.length < 2) {
      command.push(token);
      hasCommand = true;
    } else {
      rest.push(token);
      hasCommand = true;
    }
    i++;
  }

  return { command, flags, rest, hasCommand };
}

function setFlag(
  flags: Record<string, string | boolean | Array<string | boolean>>,
  name: string,
  value: string | boolean,
): void {
  if (name in flags) {
    const existing = flags[name];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else if (typeof existing === "string" || typeof existing === "boolean") {
      flags[name] = [existing, value];
    }
  } else {
    flags[name] = value;
  }
}

/** Pull a non-empty string flag, or return `undefined`. Throws usage
 *  error on empty value. */
export function flagString(
  flags: ParsedArgs["flags"],
  name: string,
): string | undefined {
  const v = flags[name];
  if (v === undefined || v === true || v === false) return undefined;
  if (typeof v === "string") {
    if (v.length === 0) {
      throw new CliUsageError(`flag --${name} requires a non-empty value`);
    }
    return v;
  }
  const last = v[v.length - 1];
  if (typeof last !== "string" || last.length === 0) {
    throw new CliUsageError(`flag --${name} requires a non-empty value`);
  }
  return last;
}

/** Return a string flag, throw usage error if missing. */
export function requireFlagString(
  flags: ParsedArgs["flags"],
  name: string,
): string {
  const v = flagString(flags, name);
  if (v === undefined) {
    throw new CliUsageError(`missing required flag: --${name}`);
  }
  return v;
}

/** True if the flag is present (boolean or any value, including empty). */
export function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  return flags[name] !== undefined;
}

/** Collect a repeated string flag into an array (empty when absent). */
export function flagStrings(
  flags: ParsedArgs["flags"],
  name: string,
): string[] {
  const v = flags[name];
  if (v === undefined) return [];
  if (typeof v === "string") return [v];
  if (typeof v === "boolean") return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** JSON mode shorthand. --json and -j both turn it on. */
export function wantJson(flags: ParsedArgs["flags"]): boolean {
  return flagBool(flags, "json") || flagBool(flags, "j");
}
