// LAMA-346 Stage 2c — the manifest handoff, proven through a real store.
//
// Stage 2b recorded the gap this closes: the target received the archive and
// its digest, but never the SOURCE MANIFEST, so it could not independently know
// the universe it was supposed to publish. This suite proves the handoff is
// real and fail-closed:
//
//   * the content fingerprint the target re-derives from the transported
//     entries is byte-for-byte the one `buildSeedManifest` computed;
//   * a manifest that arrives intact is accepted;
//   * a tampered object, a wrong recorded fingerprint, a missing manifest
//     record and a malformed document are all refused, and the download is
//     deleted rather than left on disk.
//
// It uses the local object store (the Stage 1b fixture). The REAL network hop
// through MinIO is exercised by `seed-relay-s3.test.ts`, which is gated.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  emptySeedJobArchiveFacts,
  parseSeedManifestDocument,
  seedManifestContentDigestInput,
  seedManifestDocumentProblem,
  seedManifestMetadataProblem,
  seedRelayManifestKey,
  type SeedManifestDocument,
} from "@lamasync/core";
import { buildSeedFilterUniverse } from "./seed-filter-universe.ts";
import { buildSeedManifest } from "./seed-archive.ts";
import { createLocalSeedRelayStore } from "./seed-relay-local.ts";
import {
  downloadSeedManifest,
  seedManifestContentFingerprint,
  seedManifestToDocument,
  uploadSeedManifest,
} from "./seed-transport.ts";

const SANDBOX = mkdtempSync(join(tmpdir(), "lama346-manifest-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const JOB_ID = "manifest-job-0001";

function fixtureRoot(name: string): string {
  const root = join(SANDBOX, name);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, ".lamasyncignore"), "- node_modules/\n- *.log\n");
  writeFileSync(join(root, "README.md"), "# manifest fixture\n");
  writeFileSync(join(root, "src", "index.ts"), "export const one = 1;\n");
  writeFileSync(join(root, "src", "other.ts"), "export const two = 2;\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "ignored\n");
  writeFileSync(join(root, "debug.log"), "ignored\n");
  return root;
}

function assignmentFor(root: string) {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "source-host",
    role: "both" as const,
    localPath: root,
    enabled: true,
    ignorePath: ".lamasyncignore",
    ignoreGitMetadata: true,
  };
}

async function realManifest(name: string) {
  const root = fixtureRoot(name);
  const built = buildSeedFilterUniverse(assignmentFor(root), "sync");
  expect(built.errors).toEqual([]);
  const manifest = await buildSeedManifest(root, { filter: built.universe });
  return { root, manifest, rules: built.rules };
}

describe("the manifest fingerprint algorithm has exactly one description", () => {
  test("re-deriving from the transported entries equals buildSeedManifest's fingerprint", async () => {
    const { manifest } = await realManifest("algorithm");
    const document = seedManifestToDocument(manifest);
    expect(seedManifestContentFingerprint(document.entries)).toBe(manifest.fingerprint);
    // The digest input is the shared description; a whitespace/separator change
    // in either place would break the equality above.
    expect(seedManifestContentDigestInput(document.entries)).toContain("\0file\0");
  });

  test("the transported document excludes the ignored universe", async () => {
    const { manifest } = await realManifest("excludes");
    const document = seedManifestToDocument(manifest);
    const paths = document.entries.map((entry) => entry.path);
    expect(paths).toContain("README.md");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain("debug.log");
    expect(seedManifestDocumentProblem(document)).toBeNull();
  });
});

describe("the handoff is verified at both hops", () => {
  test("an intact manifest is uploaded, read back, and re-derived by the target", async () => {
    const { manifest } = await realManifest("happy");
    const store = createLocalSeedRelayStore({ rootDir: join(SANDBOX, "store-happy") });
    const upload = await uploadSeedManifest({ store, jobId: JOB_ID, manifest, now: 1_700_000_000_000 });
    expect(upload.ok).toBe(true);
    expect(upload.metadata?.objectKey).toBe(seedRelayManifestKey(JOB_ID));
    expect(seedManifestMetadataProblem(upload.metadata!)).toBeNull();

    // The object exists in the SAME namespace as the archive would.
    const listed = await store.list("lamasync/seed/");
    expect(listed.ok && listed.value.keys).toEqual([seedRelayManifestKey(JOB_ID)]);

    const facts = {
      ...emptySeedJobArchiveFacts("tar.gz"),
      bytes: 1234,
      sha256: "a".repeat(64),
      objectKey: `lamasync/seed/${JOB_ID}/payload.tar.gz`,
      memberCount: manifest.entries.length,
      manifestFingerprint: manifest.fingerprint,
      manifestObjectKey: upload.metadata!.objectKey,
      manifestBytes: upload.metadata!.bytes,
      manifestSha256: upload.metadata!.sha256,
    };
    const destPath = join(SANDBOX, "target-manifest.json");
    const download = await downloadSeedManifest({ store, archive: facts, jobId: JOB_ID, destPath });
    expect(download.ok).toBe(true);
    expect(download.document?.entries.length).toBe(manifest.entries.length);
    expect(seedManifestContentFingerprint(download.document!.entries)).toBe(manifest.fingerprint);
    expect(existsSync(destPath)).toBe(true);
  });

  test("a tampered stored manifest is refused and the download is removed", async () => {
    const { manifest } = await realManifest("tamper");
    const rootDir = join(SANDBOX, "store-tamper");
    const store = createLocalSeedRelayStore({ rootDir });
    const upload = await uploadSeedManifest({ store, jobId: JOB_ID, manifest, now: 1_700_000_000_000 });
    expect(upload.ok).toBe(true);

    // Flip the stored bytes behind the store's back: the transport's own
    // re-hash on disk is the check that must catch this.
    const objectPath = join(rootDir, ...seedRelayManifestKey(JOB_ID).split("/"));
    const original = readFileSync(objectPath, "utf8");
    writeFileSync(objectPath, original.replace("README.md", "R3ADME.md"));

    const facts = {
      ...emptySeedJobArchiveFacts("tar.gz"),
      manifestFingerprint: manifest.fingerprint,
      manifestObjectKey: upload.metadata!.objectKey,
      manifestBytes: upload.metadata!.bytes,
      manifestSha256: upload.metadata!.sha256,
    };
    const destPath = join(SANDBOX, "tampered-manifest.json");
    const download = await downloadSeedManifest({ store, archive: facts, jobId: JOB_ID, destPath });
    expect(download.ok).toBe(false);
    expect(download.error).toContain("does not match");
    expect(existsSync(destPath)).toBe(false);
  });

  test("a manifest describing a different universe than the job recorded is refused", async () => {
    const { manifest } = await realManifest("wrong-fingerprint");
    const store = createLocalSeedRelayStore({ rootDir: join(SANDBOX, "store-wrong") });
    const upload = await uploadSeedManifest({ store, jobId: JOB_ID, manifest, now: 1_700_000_000_000 });
    expect(upload.ok).toBe(true);
    const facts = {
      ...emptySeedJobArchiveFacts("tar.gz"),
      // The source recorded a DIFFERENT content fingerprint than the document
      // carries — e.g. a stale job row. The target must refuse, not pick one.
      manifestFingerprint: "b".repeat(64),
      manifestObjectKey: upload.metadata!.objectKey,
      manifestBytes: upload.metadata!.bytes,
      manifestSha256: upload.metadata!.sha256,
    };
    const destPath = join(SANDBOX, "wrong-fingerprint.json");
    const download = await downloadSeedManifest({ store, archive: facts, jobId: JOB_ID, destPath });
    expect(download.ok).toBe(false);
    expect(download.error).toContain("different universe");
    expect(existsSync(destPath)).toBe(false);
  });

  test("a job with no transported manifest record fails closed", async () => {
    const store = createLocalSeedRelayStore({ rootDir: join(SANDBOX, "store-missing") });
    const destPath = join(SANDBOX, "missing.json");
    const download = await downloadSeedManifest({
      store,
      archive: emptySeedJobArchiveFacts("tar.gz"),
      jobId: JOB_ID,
      destPath,
    });
    expect(download.ok).toBe(false);
    expect(download.error).toContain("no recorded source manifest");
    expect(existsSync(destPath)).toBe(false);
  });

  test("an object missing from the store fails closed", async () => {
    const { manifest } = await realManifest("absent");
    const store = createLocalSeedRelayStore({ rootDir: join(SANDBOX, "store-absent") });
    const upload = await uploadSeedManifest({ store, jobId: JOB_ID, manifest, now: 1_700_000_000_000 });
    await store.delete(upload.metadata!.objectKey);
    const destPath = join(SANDBOX, "absent.json");
    const download = await downloadSeedManifest({
      store,
      archive: {
        ...emptySeedJobArchiveFacts("tar.gz"),
        manifestFingerprint: manifest.fingerprint,
        manifestObjectKey: upload.metadata!.objectKey,
        manifestBytes: upload.metadata!.bytes,
        manifestSha256: upload.metadata!.sha256,
      },
      jobId: JOB_ID,
      destPath,
    });
    expect(download.ok).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });
});

describe("a malformed transported document is refused, never cast", () => {
  const base: SeedManifestDocument = {
    version: 1,
    fingerprint: "c".repeat(64),
    filterFingerprint: "d".repeat(64),
    fileCount: 1,
    dirCount: 0,
    totalBytes: 3,
    entries: [{ path: "a.txt", kind: "file", size: 3, mtimeMs: 1, sha256: "e".repeat(64) }],
  };

  test("the baseline document is valid", () => {
    expect(seedManifestDocumentProblem(base)).toBeNull();
  });

  test("an unknown version, a traversal path and a bad count are refused", () => {
    expect(seedManifestDocumentProblem({ ...base, version: 2 as unknown as 1 })).not.toBeNull();
    expect(
      seedManifestDocumentProblem({
        ...base,
        entries: [{ path: "../escape.txt", kind: "file", size: 3, mtimeMs: 1, sha256: "e".repeat(64) }],
      }),
    ).not.toBeNull();
    expect(seedManifestDocumentProblem({ ...base, fileCount: 5 })).not.toBeNull();
  });

  test("a file without a checksum and a directory with one are refused", () => {
    expect(
      seedManifestDocumentProblem({
        ...base,
        entries: [{ path: "a.txt", kind: "file", size: 3, mtimeMs: 1, sha256: null }],
      }),
    ).not.toBeNull();
    expect(
      seedManifestDocumentProblem({
        ...base,
        fileCount: 0,
        dirCount: 1,
        totalBytes: 0,
        entries: [{ path: "d", kind: "dir", size: 0, mtimeMs: 1, sha256: "e".repeat(64) }],
      }),
    ).not.toBeNull();
  });

  test("parse returns null for anything that is not a valid document", () => {
    expect(parseSeedManifestDocument(null)).toBeNull();
    expect(parseSeedManifestDocument({ version: 1 })).toBeNull();
    expect(parseSeedManifestDocument({ ...base, entries: [{ path: 7 }] })).toBeNull();
    expect(parseSeedManifestDocument(base)).toEqual(base);
  });
});
