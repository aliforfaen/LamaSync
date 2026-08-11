/**
 * Output helpers for the `lamasync` CLI: a small fixed-width table printer,
 * a key-mask helper for API keys, and a tiny error-message renderer.
 *
 * Two output modes per command (`lamasync <cmd> [--json]`):
 *   - default: human-readable table (`printTable`) to stdout, errors to stderr.
 *   - --json: machine-readable JSON to stdout (`printJson`), always a single
 *     object so consumers can pipe to `jq` without juggling trailing commas.
 *
 * Keep this file dependency-free — no chalk, no columnify. The TUI already
 * touches the system terminal via OpenTUI; the CLI should look the same in
 * a pipe and on a TTY.
 */

const MASK_PREFIX = 8;
const MASK_SUFFIX = 4;

/**
 * Mask a sensitive string (API keys, tokens, passwords) for display.
 *
 *   maskSecret("lamasync_abc123def4567890ghijkl") → "lamasync_…7890"
 *
 * Short inputs fall back to a fully-redacted form so we never leak a 12-char
 * key by showing 8 of it. Empty input stays empty.
 */
export function maskSecret(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  if (value.length <= MASK_PREFIX + MASK_SUFFIX) return "…";
  const head = value.slice(0, MASK_PREFIX);
  const tail = value.slice(value.length - MASK_SUFFIX);
  return `${head}…${tail}`;
}

/** Recursively mask known secret fields inside a JSON-serialisable value.
 *  Used by the Folders and Backends list commands so S3 secret fields are
 *  never echoed to a terminal. New objects/arrays are walked; other values
 *  pass through unchanged. */
export function maskSecretsDeep<T>(value: T): T {
  return walk(value, new Set()) as T;
}

const SECRET_KEYS = new Set([
  "s3SecretAccessKey",
  "s3_secret_access_key",
  "resticPassword",
  "restic_password",
  "apiKey",
  "api_key",
  "cryptPassword",
  "crypt_password",
]);

function walk(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    return value.map((v) => walk(v, seen));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.has(k)) {
        if (typeof v === "string" && v.length > 0) {
          out[k] = maskSecret(v);
        } else {
          out[k] = v;
        }
      } else {
        out[k] = walk(v, seen);
      }
    }
    return out;
  }
  return value;
}

/** Print a value as pretty-printed JSON. Stable key order makes diffs sane. */
export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, jsonReplacer, 2) + "\n");
}

function jsonReplacer(_key: string, value: unknown): unknown {
  // No special-casing yet — the masker runs before serialization.
  return value;
}

/** Interface for a row the table printer can render. Cells are coerced to
 *  strings with `String(value ?? "")`. */
export interface TableColumn {
  header: string;
  key: string;
  width?: number; // fixed width; defaults to header.length and grows.
}

export function printTable(
  columns: TableColumn[],
  rows: Array<Record<string, unknown>>,
): void {
  if (rows.length === 0) {
    // Empty result still gets a helpful marker so scripts don't get confused
    // by a totally silent stdout.
    console.log("(empty)");
    return;
  }
  const widths = columns.map((col) => {
    const headerWidth = col.header.length;
    const dataWidth = rows.reduce((max, r) => {
      const cell = formatCell(r[col.key]);
      return Math.max(max, cell.length);
    }, 0);
    return Math.max(headerWidth, dataWidth, col.width ?? 0);
  });

  const fmt = (cell: string, width: number): string => {
    if (cell.length >= width) return cell;
    return cell + " ".repeat(width - cell.length);
  };

  const header = columns
    .map((col, i) => fmt(col.header, widths[i] ?? col.header.length))
    .join("  ");
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  console.log(header);
  console.log(separator);
  for (const row of rows) {
    const line = columns
      .map((col, i) => fmt(formatCell(row[col.key]), widths[i] ?? col.header.length))
      .join("  ");
    console.log(line);
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Render an error message consistently. Always goes to stderr and exits
 *  with a stable code per LAMA-229:
 *    0  ok
 *    1  runtime error
 *    2  usage error (caller error — also produced by CliUsageError)
 *    3  auth failure (HTTP 401/403)
 *    4  server unreachable / network error
 */
export function fail(message: string, code = 1): never {
  process.stderr.write(`lamasync: ${message}\n`);
  process.exit(code);
}
