// LAMA-335: the viewer's trust boundary, as a static guard.
//
// The issue's requirement is explicit: "no raw S3 credentials or broadly
// reusable backend grants reach the browser/app" and "authorization must remain
// scoped to the existing LamaSync principal and share/folder permissions".
//
// The server enforces that (see `packages/server/src/device-boundary.test.ts`
// for the 401/403 boundary and the no-secret-in-the-response assertion). This
// file guards the other half: that the SPA never grows a second path to storage
// — an SDK, a presigned URL, a credential field — that would bypass the
// authorized browse routes. A static scan is the right shape for that: the
// failure mode is somebody adding an import or a field, not a runtime branch.

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC).map((file) => ({
  path: file.slice(SRC.length),
  text: readFileSync(file, "utf8"),
}));

/** Patterns that would mean the browser could reach storage directly. */
const FORBIDDEN_EVERYWHERE: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /aws-sdk|@aws-sdk|aws4fetch|minio-js/, why: "an S3 client in the browser" },
  {
    pattern: /getSignedUrl|presign|createPresigned|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token/,
    why: "a signed storage URL granting reusable access",
  },
  { pattern: /s3_secret_key_enc|s3_access_key_id/, why: "the backend credential columns" },
];

/**
 * Files whose whole job is the viewer. These may not name a storage credential
 * at all, because nothing about showing a file's bytes needs one.
 *
 * Deliberately NOT project-wide: `pages/Backends.tsx` and `api.ts` legitimately
 * carry `s3AccessKeyId`/`s3SecretAccessKey` for the ADMIN destination form — an
 * administrator TYPING a new destination's key so the server can store it
 * encrypted (the form never receives a stored secret back; it is blanked on
 * load). That is the opposite direction from this boundary, which is about the
 * browser never holding a credential it could use to read storage directly.
 */
const VIEWER_FILES = ["pages/DataBrowser.tsx", "file-preview.ts"];

const FORBIDDEN_IN_VIEWER: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /accessKeyId|access_key_id|AccessKeyId/, why: "a storage access key" },
  { pattern: /secretAccessKey|secret_access_key|SecretAccessKey/, why: "a storage secret" },
  { pattern: /sessionToken|session_token|SessionToken/, why: "a storage session token" },
  // No catch-all on the word "credential": the viewer's prose talks about the
  // caller's LamaSync credential, which is exactly what it SHOULD use.
];

describe("browse trust boundary (LAMA-335)", () => {
  it("scans the whole SPA source", () => {
    expect(FILES.length).toBeGreaterThan(15);
    expect(FILES.some((f) => f.path === "pages/DataBrowser.tsx")).toBe(true);
  });

  it("carries no storage client and no signed storage URL", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const { pattern, why } of FORBIDDEN_EVERYWHERE) {
        if (pattern.test(file.text)) {
          offenders.push(`${file.path}: ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never names a storage credential in the viewer itself", () => {
    const offenders: string[] = [];
    for (const file of FILES.filter((f) => VIEWER_FILES.includes(f.path))) {
      for (const { pattern, why } of FORBIDDEN_IN_VIEWER) {
        if (pattern.test(file.text)) {
          offenders.push(`${file.path}: ${why}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reads bytes only through the authorized browse download helper", () => {
    const browser = FILES.find((f) => f.path === "pages/DataBrowser.tsx");
    expect(browser).toBeDefined();
    const text = browser!.text;
    // The preview and the download both go through api.*, which carries the
    // caller's normal credential and is authorized per request server-side.
    expect(text).toContain("browsePreviewBlob");
    expect(text).toContain("browseDownload");
    // …and nothing in the page fetches a storage host directly.
    expect(text).not.toMatch(/fetch\(\s*["'`]https?:\/\//);
  });

  it("renders previews without injecting markup", () => {
    const browser = FILES.find((f) => f.path === "pages/DataBrowser.tsx")!;
    // Text previews are React children (textContent). dangerouslySetInnerHTML
    // would turn a user's own file into script in a credential-bearing page.
    expect(browser.text).not.toContain("dangerouslySetInnerHTML");
    expect(browser.text).not.toContain("innerHTML");
  });
});
