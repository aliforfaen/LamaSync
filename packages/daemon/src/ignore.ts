import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import type { FilterMode } from "@lamasync/core";

/**
 * Load filter patterns from a `.lamasyncignore` / `.lamasyncmountignore` file.
 *
 * - Returns [] when `filterPath` is null/empty (no filter configured).
 * - Resolves a relative path against `baseLocalPath`.
 * - Skips blank lines and `#` comments; trims whitespace.
 * - Each remaining line passes through verbatim — the caller decides whether
 *   it's a `+` include, `-` exclude, `!` regex, etc. (rclone filter syntax).
 *
 * Missing files surface as []: a fresh checkout may legitimately have none.
 */
export function loadFilterPatterns(
  filterPath: string | null | undefined,
  baseLocalPath: string,
): string[] {
  if (!filterPath || filterPath.trim().length === 0) return [];
  const abs = isAbsolute(filterPath)
    ? filterPath
    : resolve(join(baseLocalPath, filterPath));
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
 * Resolve which filter file to use based on the operation mode.
 *
 * - `"sync"`: returns `ignorePath` (the synced `.lamasyncignore`).
 * - `"mount"`: returns `mountIgnorePath` when non-null/non-empty,
 *   otherwise falls back to `ignorePath`.
 */
export function resolveFilterPath(
  ignorePath: string | null | undefined,
  mountIgnorePath: string | null | undefined,
  mode: FilterMode,
): string | null {
  if (mode === "mount") {
    if (mountIgnorePath && mountIgnorePath.trim().length > 0) {
      return mountIgnorePath;
    }
    return ignorePath ?? null;
  }
  return ignorePath ?? null;
}

/**
 * Kept for backward compatibility — delegates to `loadFilterPatterns`.
 *
 * New code should call `loadFilterPatterns` (with `resolveFilterPath`) so the
 * resulting patterns can be passed through `rclone --filter-from`, which
 * understands the full rclone filter syntax. This shim preserves the old
 * `loadIgnorePatterns(ignorePath, localPath)` call shape.
 */
export function loadIgnorePatterns(
  ignorePath: string | null | undefined,
  baseLocalPath: string,
): string[] {
  return loadFilterPatterns(ignorePath, baseLocalPath);
}

/**
 * Materialise filter patterns into a temp file suitable for
 * `rclone --filter-from <path>`. Caller owns cleanup.
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
