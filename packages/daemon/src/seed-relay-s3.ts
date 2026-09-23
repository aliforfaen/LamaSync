// LAMA-346 Stage 2c — a REAL S3-compatible seed relay store.
//
// This is the network half of the relay contract: the same `SeedRelayStore` the
// local store implements, backed by an S3-compatible object space (MinIO in the
// disposable E2E harness, any S3 endpoint in principle). It exists so a seed
// archive and its manifest can make a genuine network hop between two machines
// instead of moving between two directories on one host.
//
// It is deliberately TEST-ONLY until the Stage 2c E2E evidence is reviewed:
// `seed-relay-s3-bounded.test.ts` reads the module graph to assert no production
// module imports it, and `SEED_ARCHIVE_TRANSPORT_IMPLEMENTED` stays `false`, so
// `POST /seed-jobs` still refuses. Nothing here reads the environment, an rclone
// config, or a daemon config: the CALLER constructs it with an explicit
// endpoint/bucket/credential, which is what keeps a configured production
// backend out of the library and out of every log line.
//
// SigV4 is implemented locally (no SDK dependency) over `fetch`. That keeps the
// store honest about what it signs and what it streams, and it is what the
// disposable MinIO integration test exercises for real.
//
// Contract points this implementation must prove, exactly like the local store:
//
//   * IMMUTABILITY. `put` refuses to replace an object whose content differs;
//     a byte-identical re-put is an idempotent success.
//   * DIGEST AS OBJECT METADATA. The SHA-256 is written as `x-amz-meta-sha256`
//     and read back by `head`, so the transport's read-back verification works
//     against a store that has no native SHA-256 (S3's ETag is MD5).
//   * STREAMING VERIFICATION. `put` hashes the source before it sends it and
//     refuses a mismatch; `get` hashes while it writes and deletes a partial or
//     wrong download.
//   * IDEMPOTENT DELETE. A 404 is a success (`alreadyAbsent`).
//   * NAMESPACE CONTAINMENT. Every key/prefix is validated before a request is
//     built; a key outside `lamasync/seed/` never reaches the endpoint.
//   * NO SYMLINKS. S3 has no symbolic links, so `list` reports none — but it
//     still refuses to treat a key outside the namespace as an object.

import { createHash, createHmac } from "crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import {
  seedRelayFailure,
  seedRelaySuccess,
  validateSeedRelayObjectKey,
  validateSeedRelayPrefix,
  type SeedRelayObjectHead,
  type SeedRelayResult,
  type SeedRelayStore,
} from "@lamasync/core";
import { seedRelayFileDigest } from "./seed-transport.ts";

/** The store's short, non-secret label. Names the TYPE, never the location. */
export const SEED_RELAY_S3_KIND = "s3";

export interface S3SeedRelayStoreOptions {
  /** Base endpoint, e.g. `http://127.0.0.1:39001`. No path component. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable clock so tests can pin `storedAt`. */
  now?: () => number;
  /**
   * Injectable fetch, so the store can be unit-tested without a server. The E2E
   * uses the real one.
   */
  fetchImpl?: typeof fetch;
  /** Bound on list pages, so a sweep can never walk forever. */
  maxListPages?: number;
}

const MAX_LIST_PAGES = 100;
const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

function bestEffortRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The caller is already reporting the real failure.
  }
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Percent-encode one path segment for SigV4's canonical URI.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped, which SigV4 requires escaped,
 * so they are encoded explicitly. `/` is preserved by the caller (segments are
 * encoded individually).
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(bucket: string, key: string): string {
  const segments = [bucket, ...(key.length === 0 ? [] : key.split("/"))];
  return `/${segments.map(encodeRfc3986).join("/")}`;
}

function amzDate(now: number): { stamp: string; date: string } {
  const iso = new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { stamp: iso, date: iso.slice(0, 8) };
}

interface SignedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
}

interface SignedRequestInput {
  method: string;
  key: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadSha256: string;
  now: number;
}

interface S3StoreInternals {
  endpoint: URL;
  options: S3SeedRelayStoreOptions;
  fetchImpl: typeof fetch;
}

function buildSignedRequest(internals: S3StoreInternals, input: SignedRequestInput): SignedRequest {
  const { endpoint, options } = internals;
  const url = new URL(endpoint.toString());
  url.pathname = canonicalUri(options.bucket, input.key);
  url.search = "";
  if (input.query) {
    for (const [name, value] of Object.entries(input.query)) url.searchParams.append(name, value);
  }
  const { stamp, date } = amzDate(input.now);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": stamp,
    ...(input.headers ?? {}),
  };
  const signedNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalQuery = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  const scope = `${date}/${options.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${options.secretAccessKey}`, date), options.region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url, method: input.method, headers };
}

/** A short, non-secret reason from an S3 error response. Never echoes the body wholesale. */
async function s3Error(response: Response): Promise<string> {
  let code = "";
  try {
    const text = (await response.text()).slice(0, 500);
    const match = /<Code>([^<]{1,80})<\/Code>/.exec(text);
    if (match) code = ` (${match[1]})`;
  } catch {
    // No body to read; the status is enough.
  }
  return `the object space answered HTTP ${response.status}${code}`;
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extract every `<Key>…</Key>` in document order. */
function xmlKeys(body: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) keys.push(xmlUnescape(match[1]!));
  return keys;
}

function xmlTag(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  return match ? xmlUnescape(match[1]!) : null;
}

/**
 * Create the relay bucket if it does not exist. Idempotent.
 *
 * Deliberately a separate, explicit call rather than something `put` does:
 * a seed transport must never implicitly create a bucket in someone's object
 * space. The disposable E2E harness calls it once; a production store owner
 * would provision the bucket themselves.
 */
export async function ensureS3SeedRelayBucket(options: S3SeedRelayStoreOptions): Promise<void> {
  const internals: S3StoreInternals = {
    endpoint: new URL(options.endpoint),
    options,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const signed = buildSignedRequest(internals, {
    method: "PUT",
    key: "",
    payloadSha256: EMPTY_SHA256,
    now: (options.now ?? (() => Date.now()))(),
  });
  const response = await internals.fetchImpl(signed.url, { method: "PUT", headers: signed.headers });
  // 200 created, 409 already exists (the only two acceptable answers).
  if (response.ok || response.status === 409) return;
  throw new Error(await s3Error(response));
}

/**
 * Create an S3-compatible seed relay store.
 *
 * The caller owns the configuration. This module never reads an environment
 * variable, so a credential can only reach it by explicit construction — and it
 * never logs one.
 */
export function createS3SeedRelayStore(options: S3SeedRelayStoreOptions): SeedRelayStore {
  const now = options.now ?? (() => Date.now());
  const internals: S3StoreInternals = {
    endpoint: new URL(options.endpoint),
    options,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  if (internals.endpoint.pathname !== "/" && internals.endpoint.pathname !== "") {
    throw new Error("the seed relay S3 endpoint must not carry a path component");
  }

  const send = async (input: SignedRequestInput, body?: BodyInit, signal?: AbortSignal): Promise<Response> => {
    const signed = buildSignedRequest(internals, input);
    return internals.fetchImpl(signed.url, {
      method: signed.method,
      headers: signed.headers,
      ...(body === undefined ? {} : { body }),
      ...(signal === undefined ? {} : { signal }),
    });
  };

  const headKey = async (key: string): Promise<SeedRelayResult<SeedRelayObjectHead>> => {    const response = await send({ method: "HEAD", key, payloadSha256: EMPTY_SHA256, now: now() });
    if (response.status === 404) return seedRelayFailure(`no object stored at ${key}`, true);
    if (!response.ok) return seedRelayFailure(await s3Error(response));
    const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (!Number.isFinite(length) || length < 0) {
      return seedRelayFailure("the object space did not report the object's size");
    }
    const digest = response.headers.get("x-amz-meta-sha256");
    const lastModified = response.headers.get("last-modified");
    const parsedModified = lastModified === null ? Number.NaN : Date.parse(lastModified);
    return seedRelaySuccess({
      key,
      bytes: length,
      sha256: digest !== null && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
      storedAt: Number.isFinite(parsedModified) ? Math.round(parsedModified) : now(),
    });
  };

  /**
   * Remove a key after a failed PUT, never throwing.
   *
   * A failed or cancelled upload must not leave something for a target to find,
   * and a store that committed the object before the connection dropped is
   * exactly the case a plain "return failure" would miss.
   */
  const bestEffortDeleteKey = async (key: string): Promise<void> => {
    try {
      await send({ method: "DELETE", key, payloadSha256: EMPTY_SHA256, now: now() });
    } catch {
      // The caller is already reporting the real failure.
    }
  };

  return {
    kind: SEED_RELAY_S3_KIND,

    async put(input) {
      const verdict = validateSeedRelayObjectKey(input.key);
      if (!verdict.ok) return seedRelayFailure(verdict.error ?? "the object key is not usable");
      if (!Number.isSafeInteger(input.expected.bytes) || input.expected.bytes <= 0) {
        return seedRelayFailure("the expected byte count is not a positive integer");
      }
      if (!/^[0-9a-f]{64}$/.test(input.expected.sha256)) {
        return seedRelayFailure("the expected SHA-256 is not a 64-character hex digest");
      }
      if (input.signal?.aborted) return seedRelayFailure("the upload was cancelled");

      // Immutability first: an object already there is only re-put when it is
      // byte-identical. A differing object is refused, never overwritten.
      const existing = await headKey(input.key);
      if (existing.ok) {
        if (existing.value.bytes !== input.expected.bytes || existing.value.sha256 !== input.expected.sha256) {
          return seedRelayFailure(
            `an object already exists at ${input.key} with different content; seed archive objects are immutable`,
          );
        }
        return existing;
      }
      if (!existing.notFound) return existing;

      // Materialize a bytes source (the manifest) so both kinds share one
      // streaming path, and hash the source BEFORE sending: the digest is what
      // we sign and what we claim as object metadata, never a caller's guess.
      let sourcePath: string;
      let tempPath: string | null = null;
      if (input.source.kind === "file") {
        if (!existsSync(input.source.path)) {
          return seedRelayFailure("the source file to upload does not exist");
        }
        sourcePath = input.source.path;
      } else {
        tempPath = join(tmpdir(), `lamasync-s3-put-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
        try {
          writeFileSync(tempPath, input.source.data);
        } catch (err) {
          return seedRelayFailure(
            `the source bytes could not be staged: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        sourcePath = tempPath;
      }
      try {
        let digest: { bytes: number; sha256: string };
        try {
          digest = await seedRelayFileDigest(sourcePath);
        } catch (err) {
          return seedRelayFailure(`the source could not be read: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (digest.bytes !== input.expected.bytes) {
          return seedRelayFailure(`the source is ${digest.bytes} bytes but ${input.expected.bytes} were recorded`);
        }
        if (digest.sha256 !== input.expected.sha256) {
          return seedRelayFailure("the source SHA-256 does not match the recorded digest");
        }

        let bytesSent = 0;
        const meter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytesSent += chunk.length;
            input.onProgress?.({ bytesDone: bytesSent, bytesTotal: digest.bytes });
            callback(null, chunk);
          },
        });
        const body = Readable.toWeb(createReadStream(sourcePath).pipe(meter)) as unknown as ReadableStream<Uint8Array>;
        try {
          const response = await send(
            {
              method: "PUT",
              key: input.key,
              headers: {
                "content-length": String(digest.bytes),
                "content-type": "application/octet-stream",
                "x-amz-meta-sha256": digest.sha256,
              },
              payloadSha256: digest.sha256,
              now: now(),
            },
            body,
            input.signal,
          );
          if (!response.ok) {
            await bestEffortDeleteKey(input.key);
            return seedRelayFailure(await s3Error(response));
          }
        } catch (err) {
          // A cancelled or failed PUT must not leave a partial object behind:
          // S3 commits a PUT atomically, but a best-effort delete makes the
          // "nothing is left to find" property hold even against a store that
          // committed before the connection dropped.
          await bestEffortDeleteKey(input.key);
          return seedRelayFailure(`storing ${input.key} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        if (tempPath !== null) bestEffortRm(tempPath);
      }
      return headKey(input.key);
    },

    async head(key) {
      const verdict = validateSeedRelayObjectKey(key);
      if (!verdict.ok) return seedRelayFailure(verdict.error ?? "the object key is not usable");
      return headKey(key);
    },

    async get(input) {
      const verdict = validateSeedRelayObjectKey(input.key);
      if (!verdict.ok) return seedRelayFailure(verdict.error ?? "the object key is not usable");
      if (input.signal?.aborted) return seedRelayFailure("the download was cancelled");
      let response: Response;
      try {
        response = await send({ method: "GET", key: input.key, payloadSha256: EMPTY_SHA256, now: now() }, undefined, input.signal);
      } catch (err) {
        return seedRelayFailure(`reading ${input.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (response.status === 404) return seedRelayFailure(`no object stored at ${input.key}`, true);
      if (!response.ok) return seedRelayFailure(await s3Error(response));
      if (response.body === null) return seedRelayFailure("the object space returned no body");

      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > input.expected.bytes) {
            callback(new Error("the object is larger than the recorded byte count"));
            return;
          }
          hash.update(chunk);
          input.onProgress?.({ bytesDone: bytes, bytesTotal: input.expected.bytes });
          callback(null, chunk);
        },
      });
      try {
        mkdirSync(dirname(input.destPath), { recursive: true });
        await pipeline(
          Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          meter,
          createWriteStream(input.destPath),
          input.signal ? { signal: input.signal } : {},
        );
      } catch (err) {
        bestEffortRm(input.destPath);
        return seedRelayFailure(`reading ${input.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const observed = { bytes, sha256: hash.digest("hex") };
      if (observed.bytes !== input.expected.bytes) {
        bestEffortRm(input.destPath);
        return seedRelayFailure(
          `the stored object is ${observed.bytes} bytes but ${input.expected.bytes} were recorded`,
        );
      }
      if (observed.sha256 !== input.expected.sha256) {
        bestEffortRm(input.destPath);
        return seedRelayFailure("the stored object's SHA-256 does not match the recorded digest");
      }
      return seedRelaySuccess({ bytes: observed.bytes, sha256: observed.sha256 });
    },

    async delete(key) {
      const verdict = validateSeedRelayObjectKey(key);
      if (!verdict.ok) return seedRelayFailure(verdict.error ?? "the object key is not usable");
      // S3's DELETE is idempotent and answers 204 for an absent object, so a
      // HEAD first is what makes `alreadyAbsent` truthful instead of a guess.
      // Cleanup only needs `ok`, but a store that reports a phantom deletion is
      // a store whose logs lie.
      const present = await headKey(key);
      if (!present.ok) {
        if (present.notFound) return seedRelaySuccess({ deleted: false, alreadyAbsent: true });
        return present;
      }
      let response: Response;
      try {
        response = await send({ method: "DELETE", key, payloadSha256: EMPTY_SHA256, now: now() });
      } catch (err) {
        return seedRelayFailure(`deleting ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (response.status === 404) return seedRelaySuccess({ deleted: false, alreadyAbsent: true });
      if (!response.ok) return seedRelayFailure(await s3Error(response));
      return seedRelaySuccess({ deleted: true, alreadyAbsent: false });
    },

    async list(prefix) {
      const verdict = validateSeedRelayPrefix(prefix);
      if (!verdict.ok) return seedRelayFailure(verdict.error ?? "the list prefix is not usable");
      const keys: string[] = [];
      const maxPages = options.maxListPages ?? MAX_LIST_PAGES;
      let continuation: string | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
        if (continuation !== null) query["continuation-token"] = continuation;
        let response: Response;
        try {
          response = await send({ method: "GET", key: "", query, payloadSha256: EMPTY_SHA256, now: now() });
        } catch (err) {
          return seedRelayFailure(`listing ${prefix} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!response.ok) return seedRelayFailure(await s3Error(response));
        const body = await response.text();
        for (const key of xmlKeys(body)) {
          if (key.startsWith(prefix)) keys.push(key);
        }
        if (xmlTag(body, "IsTruncated") !== "true") break;
        continuation = xmlTag(body, "NextContinuationToken");
        if (continuation === null) break;
      }
      keys.sort();
      // S3 has no symbolic links, so nothing is ever skipped for being one.
      return seedRelaySuccess({ keys, skippedSymlinks: [] });
    },
  };
}
