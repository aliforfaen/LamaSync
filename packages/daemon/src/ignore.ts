import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

/**
 * Load rclone glob patterns from a `.lamasyncignore` file.
 *
 * - Returns [] when `ignorePath` is null/empty (no ignore configured).
 * - Resolves a relative path against `baseLocalPath`.
 * - Skips blank lines and `#` comments; trims whitespace.
 * - Each remaining line is a glob and passes through verbatim.
 *
 * Missing files surface as []: a fresh checkout may legitimately have none.
 */
export function loadIgnorePatterns(
  ignorePath: string | null | undefined,
  baseLocalPath: string,
): string[] {
  if (!ignorePath || ignorePath.trim().length === 0) return [];
  const abs = isAbsolute(ignorePath)
    ? ignorePath
    : resolve(join(baseLocalPath, ignorePath));
  if (!existsSync(abs)) return [];
  const text = readFileSync(abs, "utf8");
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

/**
 * Materialise ignore patterns into a temp file suitable for
 * `rclone --exclude-from <path>`. Caller owns cleanup.
 */
export function writeExcludeFile(
  patterns: string[],
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lamasync-exclude-"));
  const filePath = join(
    dir,
    `lamasync-exclude-${process.pid}-${randomBytes(6).toString("hex")}.txt`,
  );
  // Trailing newline so rclone never sees an unterminated final pattern.
  writeFileSync(filePath, patterns.join("\n") + (patterns.length ? "\n" : ""));
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  return { path: filePath, cleanup };
}