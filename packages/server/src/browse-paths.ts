import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export function resolveBrowsePath(root: string, input: string): string | null {
  if (input.includes("\0")) return null;

  // Normalize Windows separators so segment validation is uniform.
  const normalized = input.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null;

  const segments = normalized.split("/");
  // Empty input maps to the root; otherwise every segment must be non-empty
  // and must not be a traversal.
  if (segments.length !== 1 || segments[0] !== "") {
    if (segments.some((segment) => segment === "" || segment === "..")) return null;
  }

  const target = input === "" ? root : join(root, normalized);
  let resolved: string;
  try {
    resolved = realpathSync(target);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }

  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

export function statEntry(path: string): { size: number; mtime: number; type: "dir" | "file" } | null {
  try {
    const stat = statSync(path);
    return {
      size: stat.isDirectory() ? 0 : stat.size,
      mtime: Math.floor(stat.mtimeMs),
      type: stat.isDirectory() ? "dir" : "file",
    };
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}
