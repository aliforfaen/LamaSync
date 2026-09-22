// LAMA-346 Stage 1b — a local object store that satisfies the seed relay
// contract.
//
// This is the integration-test fixture for the transport, and it is also a
// legitimate store in its own right: an object store whose objects are files
// under one root directory. It is NOT the S3 relay. Nothing here reads a
// backend configuration, an rclone config, an endpoint, a bucket or a
// credential — the constructor takes a directory and nothing else — and no
// live host is contacted. Wiring a configured S3 backend is deliberately out of
// scope, which is why `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false`.
//
// Contract points this implementation exists to prove, because the transport
// depends on them:
//
//   * KEY CONTAINMENT. Every key is validated with the shared
//     `validateSeedRelayObjectKey` before it touches the filesystem, and the
//     resolved path must still be inside the root. A key that escapes the seed
//     namespace — or the root — is refused, never normalised into place.
//   * IMMUTABILITY. `put` refuses to replace an object whose content differs.
//     Re-putting byte-identical content is an idempotent success, which is what
//     makes a retried upload safe.
//   * STREAMING VERIFICATION. Both `put` and `get` hash while they move bytes
//     and compare against the caller's expected digest, and a short or long
//     stream fails. A partial file is deleted, never left behind.
//   * ATOMIC PUBLICATION. Bytes land in a temp file and are renamed into place,
//     so a reader never sees a half-written object.
//   * IDEMPOTENT DELETE. Deleting an absent object is a success (`alreadyAbsent`),
//     which is what makes cleanup re-runnable.
//
// Each object carries a `<name>.sha256` sidecar digest — the local equivalent of
// object-store metadata — so `head` can report a digest without re-reading a
// multi-gigabyte archive. Sidecars are an implementation detail: `list` never
// returns them, and `delete` removes them with their object.

import { createHash } from "crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve, sep } from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { randomBytes } from "crypto";
import {
  seedRelayFailure,
  seedRelaySuccess,
  validateSeedRelayObjectKey,
  validateSeedRelayPrefix,
  type SeedRelayObjectHead,
  type SeedRelayPutSource,
  type SeedRelayResult,
  type SeedRelayStore,
} from "@lamasync/core";

/**
 * Remove a path, never throwing.
 *
 * A store root can be in a state where `rm` itself fails (a parent that is a
 * file yields EFAULT on some platforms, not ENOTDIR), and a cleanup that throws
 * on the failure path would replace the real error with a confusing one.
 */
function bestEffortRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing useful to do: the caller is already reporting the real failure.
  }
}

/** Suffix of the digest sidecar stored next to an object. */
export const SEED_RELAY_DIGEST_SUFFIX = ".sha256";

/** Working directory inside the root where partial uploads live. */
export const SEED_RELAY_TMP_DIR = ".lamasync-seed-relay-tmp";

export interface LocalSeedRelayStoreOptions {
  /** Directory that holds the object namespace. Created if missing. */
  rootDir: string;
  /** Injectable clock so tests can pin `storedAt`. */
  now?: () => number;
}

/**
 * Resolve a validated key to an absolute path inside `rootDir`, or explain why
 * it cannot be. Belt and braces behind `validateSeedRelayObjectKey`: even a
 * valid key is refused if the resolved path is not under the root.
 */
export function resolveSeedRelayObjectPath(
  rootDir: string,
  key: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const verdict = validateSeedRelayObjectKey(key);
  if (!verdict.ok) return { ok: false, error: verdict.error ?? "the object key is not usable" };
  const root = resolve(rootDir);
  const full = resolve(root, ...key.split("/"));
  if (full !== root && !full.startsWith(root + sep)) {
    return { ok: false, error: "the object key resolves outside the object store root" };
  }
  return { ok: true, path: full };
}

/**
 * Copy a file into `dest`, hashing as it goes, and abort if it overruns
 * `maxBytes`.
 *
 * `pipeline` owns the abort and error plumbing: it destroys both streams on any
 * failure, so a cancelled transfer cannot leave a dangling stream or an
 * unhandled `error` event behind (which a manual `destroy(err)` does, and which
 * would surface as a stray unhandled rejection rather than a failed call).
 */
async function copyAndHash(input: {
  source: string;
  dest: string;
  maxBytes: number;
  signal?: AbortSignal;
  onProgress?: (bytesDone: number) => void;
}): Promise<{ bytes: number; sha256: string; overflow: boolean }> {
  if (input.signal?.aborted) throw new Error("aborted");
  const hash = createHash("sha256");
  let bytes = 0;
  let overflow = false;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > input.maxBytes) {
        // Never read past what the caller told us to expect: a store that
        // streams an unbounded object is a disk-fill vector.
        overflow = true;
        callback(new Error("the source is larger than the recorded byte count"));
        return;
      }
      hash.update(chunk);
      input.onProgress?.(bytes);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(input.source),
    meter,
    createWriteStream(input.dest),
    input.signal ? { signal: input.signal } : {},
  );
  return { bytes, sha256: hash.digest("hex"), overflow };
}

/**
 * A seed relay store backed by a local directory.
 *
 * `kind` is the short, non-secret label the transport logs: it names the store
 * TYPE, never its location.
 */
export function createLocalSeedRelayStore(options: LocalSeedRelayStoreOptions): SeedRelayStore {
  const rootDir = resolve(options.rootDir);
  const now = options.now ?? (() => Date.now());
  const tmpDir = join(rootDir, SEED_RELAY_TMP_DIR);

  const digestPathFor = (objectPath: string): string => `${objectPath}${SEED_RELAY_DIGEST_SUFFIX}`;

  const readDigest = (objectPath: string): string | null => {
    try {
      const text = readFileSync(digestPathFor(objectPath), "utf8").trim();
      return /^[0-9a-f]{64}$/.test(text) ? text : null;
    } catch {
      return null;
    }
  };

  const headAt = (key: string, objectPath: string): SeedRelayResult<SeedRelayObjectHead> => {
    if (!existsSync(objectPath)) return seedRelayFailure(`no object stored at ${key}`, true);
    const stat = statSync(objectPath);
    if (!stat.isFile()) return seedRelayFailure(`${key} is not a stored object`);
    return seedRelaySuccess({
      key,
      bytes: stat.size,
      sha256: readDigest(objectPath),
      storedAt: Math.round(stat.mtimeMs),
    });
  };

  const deleteAt = (key: string, objectPath: string): SeedRelayResult<{
    deleted: boolean;
    alreadyAbsent: boolean;
  }> => {
    const present = existsSync(objectPath);
    const digestPresent = existsSync(digestPathFor(objectPath));
    try {
      rmSync(objectPath, { force: true });
      rmSync(digestPathFor(objectPath), { force: true });
    } catch (err) {
      return seedRelayFailure(
        `could not delete ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return seedRelaySuccess({ deleted: present || digestPresent, alreadyAbsent: !present });
  };

  return {
    kind: "local-fs",

    async put(input) {
      const target = resolveSeedRelayObjectPath(rootDir, input.key);
      if (!target.ok) return seedRelayFailure(target.error);
      if (!Number.isSafeInteger(input.expected.bytes) || input.expected.bytes <= 0) {
        return seedRelayFailure("the expected archive byte count is not a positive integer");
      }

      // Immutability: an object that is already there is only re-put when it is
      // byte-identical. Anything else is refused, never overwritten.
      if (existsSync(target.path)) {
        const existing = headAt(input.key, target.path);
        if (!existing.ok) return existing;
        if (
          existing.value.bytes !== input.expected.bytes ||
          existing.value.sha256 !== input.expected.sha256
        ) {
          return seedRelayFailure(
            `an object already exists at ${input.key} with different content; seed archive objects are immutable`,
          );
        }
        return existing;
      }

      let sourcePath = input.source.kind === "file" ? input.source.path : "";
      const stagingPath = join(tmpDir, `${process.pid}-${randomBytes(8).toString("hex")}.part`);
      try {
        if (input.source.kind === "bytes") sourcePath = writeTempSource(tmpDir, input.source.data);
        mkdirSync(dirname(target.path), { recursive: true });
        mkdirSync(tmpDir, { recursive: true });
        const copied = await copyAndHash({
          source: sourcePath,
          dest: stagingPath,
          maxBytes: input.expected.bytes,
          ...(input.signal ? { signal: input.signal } : {}),
          onProgress: (bytesDone) => input.onProgress?.({ bytesDone, bytesTotal: input.expected.bytes }),
        });
        if (copied.overflow) {
          return seedRelayFailure(
            `the source is larger than the recorded ${input.expected.bytes} bytes; refusing to store it`,
          );
        }
        if (copied.bytes !== input.expected.bytes) {
          return seedRelayFailure(
            `the source is ${copied.bytes} bytes but ${input.expected.bytes} were recorded`,
          );
        }
        if (copied.sha256 !== input.expected.sha256) {
          return seedRelayFailure("the source SHA-256 does not match the recorded digest");
        }
        // Atomic publication: readers never see a half-written object.
        renameSync(stagingPath, target.path);
        writeFileSync(digestPathFor(target.path), `${copied.sha256}\n`);
      } catch (err) {
        return seedRelayFailure(
          `storing ${input.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        bestEffortRm(stagingPath);
        if (input.source.kind === "bytes" && sourcePath.length > 0) bestEffortRm(sourcePath);
      }
      return headAt(input.key, target.path);
    },

    async head(key) {
      const target = resolveSeedRelayObjectPath(rootDir, key);
      if (!target.ok) return seedRelayFailure(target.error);
      return headAt(key, target.path);
    },

    async get(input) {
      const target = resolveSeedRelayObjectPath(rootDir, input.key);
      if (!target.ok) return seedRelayFailure(target.error);
      if (input.signal?.aborted) return seedRelayFailure("the download was cancelled");
      if (!existsSync(target.path)) {
        return seedRelayFailure(`no object stored at ${input.key}`, true);
      }
      try {
        mkdirSync(dirname(input.destPath), { recursive: true });
        const copied = await copyAndHash({
          source: target.path,
          dest: input.destPath,
          maxBytes: input.expected.bytes,
          ...(input.signal ? { signal: input.signal } : {}),
          onProgress: (bytesDone) => input.onProgress?.({ bytesDone, bytesTotal: input.expected.bytes }),
        });
        // Fail closed and leave nothing behind: a partial or wrong download is
        // deleted rather than handed to an extractor.
        if (copied.overflow || copied.bytes !== input.expected.bytes) {
          bestEffortRm(input.destPath);
          return seedRelayFailure(
            `the stored object is ${copied.bytes} bytes but ${input.expected.bytes} were recorded`,
          );
        }
        if (copied.sha256 !== input.expected.sha256) {
          bestEffortRm(input.destPath);
          return seedRelayFailure("the stored object's SHA-256 does not match the recorded digest");
        }
        return seedRelaySuccess({ bytes: copied.bytes, sha256: copied.sha256 });
      } catch (err) {
        bestEffortRm(input.destPath);
        return seedRelayFailure(
          `reading ${input.key} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async delete(key) {
      const target = resolveSeedRelayObjectPath(rootDir, key);
      if (!target.ok) return seedRelayFailure(target.error);
      return deleteAt(key, target.path);
    },

    async list(prefix) {
      const verdict = validateSeedRelayPrefix(prefix);
      if (!verdict.ok) return seedRelayFailure(verdict.error ?? "the list prefix is not usable");
      const root = resolve(rootDir);
      const keys: string[] = [];
      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          const relative = full.slice(root.length + 1).split(sep).join("/");
          if (!relative.startsWith(prefix)) continue;
          // The digest sidecar is an implementation detail, never an object.
          if (relative.endsWith(SEED_RELAY_DIGEST_SUFFIX)) continue;
          keys.push(relative);
        }
      };
      walk(root);
      keys.sort();
      return seedRelaySuccess({ keys });
    },
  };
}

/** Materialise an in-memory source so `put` can stream it like a file. */
function writeTempSource(tmpDir: string, data: Uint8Array): string {
  mkdirSync(tmpDir, { recursive: true });
  const path = join(tmpDir, `${process.pid}-${randomBytes(8).toString("hex")}.src`);
  writeFileSync(path, data);
  return path;
}

/** Convenience for tests and callers that already have the bytes. */
export function seedRelayBytesSource(data: Uint8Array): SeedRelayPutSource {
  return { kind: "bytes", data };
}
