// LAMA-301: shared deploy output scrubbing. Lives in core so the server
// (audit boundary) and the deploy agent (transport hygiene) apply the
// same rules. See docs/prod-deploy.md for the deploy security model.

/** Maximum persisted output tail per job (final 16 KiB). */
export const DEPLOY_OUTPUT_TAIL_CAP = 16 * 1024;

/**
 * Remove credential-looking material from deploy output:
 *   - bearer tokens (`Authorization: Bearer …`);
 *   - `lmsk.<id>.<secret>` managed-key tokens;
 *   - `KEY=value` / `KEY: value` pairs for secret-ish key names;
 *   - long opaque hex/base64url runs (≥ 32 chars) that could be leaked
 *     secrets — image digests (`sha256:…`) are preserved.
 */
export function scrubDeployOutput(text: string): string {
  return (
    text
      .replace(/Bearer\s+\S+/gi, "[redacted]")
      .replace(/\blmsk\.[A-Za-z0-9]+\.[A-Za-z0-9_-]+/g, "lmsk.[redacted]")
      .replace(
        /([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|credential)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?!\[redacted\b)([^\s;&'"]+)/gi,
        (_m, key: string, sep: string) => `${key}${sep}[redacted]`,
      )
      // Long opaque secrets (hex or base64url), but NOT sha256:<hex> digests.
      .replace(/(?<!sha256:)\b[A-Fa-f0-9]{32,}\b/g, "[redacted]")
      .replace(/(?<!sha256:)\b[A-Za-z0-9_-]{40,}\b/g, (m) =>
        /^[A-Za-z0-9+/=_-]+$/.test(m) ? "[redacted]" : m,
      )
  );
}

/**
 * Keep only the FINAL `cap` bytes (default DEPLOY_OUTPUT_TAIL_CAP) of the
 * accumulated output, aligned so the cut never splits a UTF-8 sequence
 * badly (Buffer-based; TypeScript string units are UTF-16, so slice on
 * the buffer and decode back).
 */
export function capDeployOutputTail(text: string, cap = DEPLOY_OUTPUT_TAIL_CAP): string {
  if (text.length === 0) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  const sliced = buf.subarray(buf.length - cap);
  // Drop a possibly-truncated leading code point.
  let start = 0;
  while (start < sliced.length && (sliced[start]! & 0xc0) === 0x80) start++;
  return `[…truncated…]${sliced.subarray(start).toString("utf8")}`;
}
