import { createHmac, createHash } from "node:crypto";
import type { S3FolderConfig } from "@lamasync/core";

export interface S3Entry {
  name: string;
  type: "dir" | "file";
  size: number;
  lastModified: number;
}

export interface S3Listing {
  entries: S3Entry[];
}

/** Recursive size aggregation for one S3 key prefix (LAMA-321). */
export interface S3PrefixSize {
  objectCount: number;
  bytes: number;
}

export interface S3ListError {
  message: string;
  cause?: unknown;
}

export class S3ListObjectsError extends Error {
  constructor(message: string, public readonly causeError?: unknown) {
    super(message);
    this.name = "S3ListObjectsError";
  }
}

/** SHA-256 of an empty request body — the canonical payload hash for GET. */
const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Default fetch implementation used when callers don't inject one (tests
// override it to fake ListObjectsV2 pages without a network).
let defaultS3Fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response> =
  globalThis.fetch;

export function __setDefaultS3Fetch(
  impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  defaultS3Fetch = impl;
}

export interface SignRequestResult {
  signature: string;
  canonicalRequest: string;
  stringToSign: string;
}

export async function signRequest(
  method: string,
  host: string,
  path: string,
  query: Record<string, string>,
  payloadHash: string,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  service = "s3",
  now: Date = new Date(),
  extraHeaders: Record<string, string> = {},
): Promise<SignRequestResult> {
  const dateStamp = formatDateStamp(now);
  const amzDate = formatAmzDate(now);

  const headerEntries = [
    ["host", host.toLowerCase()],
    ...Object.entries(extraHeaders),
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalHeaders = headerEntries
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const canonicalUri = path === "" ? "/" : path.split("/").map(uriEncode).join("/");
  const canonicalQuery = buildCanonicalQueryString(query);

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  const signingKey = await deriveSigningKey(secretAccessKey, dateStamp, region, service);
  const signature = await hmacSha256Hex(signingKey, stringToSign);

  return { signature, canonicalRequest, stringToSign };
}

export async function listS3Objects(
  s3: S3FolderConfig,
  prefix: string,
  limit: number,
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = defaultS3Fetch,
): Promise<S3Listing> {
  if (prefix.includes("\0") || prefix.includes("..")) {
    throw new S3ListObjectsError("invalid S3 prefix");
  }
  const page = await runListObjectsPage(s3, prefix, limit, { delimiter: "/" }, fetchImpl);
  const entries: S3Entry[] = [];
  for (const content of page.contents) {
    entries.push({
      name: relativeName(content.key, prefix),
      type: "file",
      size: content.size,
      lastModified: content.lastModified,
    });
  }
  for (const commonPrefix of page.prefixes) {
    entries.push({
      name: relativeName(commonPrefix, prefix),
      type: "dir",
      size: 0,
      lastModified: 0,
    });
  }
  return { entries };
}

/**
 * LAMA-321: recursively sum the object count and bytes of every object
 * under `prefix` (no delimiter, so nested keys are included). ListObjectsV2
 * caps a page at `max-keys` (1000), so the loop follows the
 * `continuation-token` until the bucket reports the listing is complete.
 * Pure apart from the network — `fetchImpl` is injectable for tests.
 */
export async function sizeS3Prefix(
  s3: S3FolderConfig,
  prefix: string,
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = defaultS3Fetch,
): Promise<S3PrefixSize> {
  if (prefix.includes("\0") || prefix.includes("..")) {
    throw new S3ListObjectsError("invalid S3 prefix");
  }
  let objectCount = 0;
  let bytes = 0;
  let continuationToken: string | null = null;
  for (;;) {
    const page = await runListObjectsPage(
      s3,
      prefix,
      1000,
      continuationToken === null ? {} : { continuationToken },
      fetchImpl,
    );
    for (const content of page.contents) {
      objectCount += 1;
      bytes += content.size;
    }
    if (!page.truncated || page.nextContinuationToken === null) break;
    continuationToken = page.nextContinuationToken;
  }
  return { objectCount, bytes };
}

/** One ListObjectsV2 page parsed into its raw parts. */
interface ListObjectsPage {
  contents: Array<{ key: string; size: number; lastModified: number }>;
  prefixes: string[];
  truncated: boolean;
  nextContinuationToken: string | null;
}

interface ListPageOptions {
  delimiter?: string;
  continuationToken?: string;
}

/**
 * Issue one signed ListObjectsV2 request and parse the response. The URL
 * carries only list parameters (list-type/prefix/max-keys/delimiter/
 * continuation-token); auth rides in the Authorization header (LAMA-320:
 * Backblaze B2 rejects presigned query parameters).
 */
async function runListObjectsPage(
  s3: S3FolderConfig,
  prefix: string,
  limit: number,
  opts: ListPageOptions,
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<ListObjectsPage> {
  const endpoint = s3.endpoint.replace(/\/+$/, "");
  const bucket = s3.bucket;
  const accessKeyId = s3.accessKeyId;
  const secretAccessKey = s3.secretAccessKey;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new S3ListObjectsError("missing S3 credentials");
  }

  const region = s3.region && s3.region.trim() !== "" ? s3.region : "us-east-1";

  const urlBase = endpoint.startsWith("http://") || endpoint.startsWith("https://")
    ? endpoint
    : `https://${endpoint}`;
  const url = new URL(`${urlBase}/${bucket}`);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("prefix", prefix);
  url.searchParams.set("max-keys", String(limit));
  if (opts.delimiter !== undefined) url.searchParams.set("delimiter", opts.delimiter);
  if (opts.continuationToken !== null && opts.continuationToken !== undefined) {
    url.searchParams.set("continuation-token", opts.continuationToken);
  }

  // Preserve deterministic query-string ordering for signing.
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = formatDateStamp(now);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const signed = await signRequest(
    "GET",
    url.host,
    url.pathname,
    query,
    EMPTY_PAYLOAD_SHA256,
    accessKeyId,
    secretAccessKey,
    region,
    "s3",
    now,
    { "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256, "x-amz-date": amzDate },
  );
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=host;x-amz-content-sha256;x-amz-date, ` +
    `Signature=${signed.signature}`;

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256,
        "x-amz-date": amzDate,
      },
    });
  } catch (err) {
    throw new S3ListObjectsError(`S3 request failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  const bodyText = await response.text();
  if (!response.ok) {
    throw new S3ListObjectsError(`S3 request returned ${response.status}: ${bodyText.slice(0, 200)}`);
  }

  return parseListObjectsPage(bodyText, prefix);
}

function parseListObjectsPage(xml: string, prefix: string): ListObjectsPage {
  const root = parseXml(xml);
  const contents: ListObjectsPage["contents"] = [];
  const prefixes: string[] = [];

  for (const child of root.children) {
    if (typeof child === "string") continue;
    if (child.tag === "Contents") {
      const key = firstText(child, "Key");
      const lastModified = firstText(child, "LastModified");
      const sizeText = firstText(child, "Size");
      if (key) {
        const size = sizeText ? Number.parseInt(sizeText, 10) : 0;
        contents.push({
          key,
          size: Number.isNaN(size) ? 0 : size,
          lastModified: parseIsoDate(lastModified),
        });
      }
    } else if (child.tag === "CommonPrefixes") {
      const key = firstText(child, "Prefix");
      if (key) prefixes.push(key);
    }
  }

  const truncatedText = firstText(root, "IsTruncated");
  const token = firstText(root, "NextContinuationToken");
  return {
    contents,
    prefixes,
    truncated: truncatedText === "true",
    nextContinuationToken: token && token.length > 0 ? token : null,
  };
}

function relativeName(key: string, prefix: string): string {
  const trimmed = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return trimmed.replace(/\/$/, "");
}

function parseIsoDate(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function firstText(node: XmlNode, tag: string): string | null {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === tag) {
      return child.children.filter((c): c is string => typeof c === "string").join("").trim();
    }
  }
  return null;
}

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

function parseXml(xml: string): XmlNode {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  let textBuffer = "";

  function flushText(): void {
    if (textBuffer.length === 0) return;
    const trimmed = textBuffer.trim();
    if (trimmed.length > 0) {
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(trimmed);
    }
    textBuffer = "";
  }

  while (i < xml.length) {
    if (xml[i] === "<") {
      flushText();
      // Skip XML declaration and processing instructions: <?xml ... ?>
      if (i + 1 < xml.length && xml[i + 1] === "?") {
        const end = xml.indexOf("?>", i + 2);
        i = end === -1 ? xml.length : end + 2;
        continue;
      }
      // Skip XML comments.
      if (i + 3 < xml.length && xml[i + 1] === "!" && xml[i + 2] === "-" && xml[i + 3] === "-") {
        const end = xml.indexOf("-->", i + 4);
        i = end === -1 ? xml.length : end + 3;
        continue;
      }
      const closeIdx = xml.indexOf(">", i);
      if (closeIdx === -1) break;
      const tagContent = xml.substring(i + 1, closeIdx);
      i = closeIdx + 1;

      if (tagContent.startsWith("/")) {
        // Closing tag
        const closed = stack.pop();
        if (closed && stack.length === 0) root = closed;
      } else if (tagContent.endsWith("/")) {
        // Self-closing tag
        const { tag, attrs } = parseTag(tagContent.slice(0, -1).trim());
        const node: XmlNode = { tag, attrs, children: [] };
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        if (stack.length === 0) root = node;
      } else {
        // Opening tag
        const { tag, attrs } = parseTag(tagContent);
        const node: XmlNode = { tag, attrs, children: [] };
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(node);
        stack.push(node);
      }
    } else {
      textBuffer += xml[i];
      i++;
    }
  }

  flushText();
  if (!root) throw new S3ListObjectsError("failed to parse S3 XML response");
  return root;
}

function parseTag(content: string): { tag: string; attrs: Record<string, string> } {
  const parts = content.split(/\s+/).filter((p) => p.length > 0);
  const tag = parts[0] ?? "";
  const attrs: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq === -1) continue;
    const key = parts[i].slice(0, eq);
    let value = parts[i].slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attrs[key] = value;
  }
  return { tag, attrs };
}

function buildCanonicalQueryString(query: Record<string, string>): string {
  const entries = Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) =>
      ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    );
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

function uriEncode(value: string): string {
  // AWS URI-encode: encode every byte except unreserved characters.
  // encodeURIComponent already encodes spaces as %20 and leaves -_.~ unencoded.
  return encodeURIComponent(value)
    .replace(/!/g, "%21")
    .replace(/\*/g, "%2A")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

async function sha256Hex(message: string): Promise<string> {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

async function hmacSha256Hex(key: Uint8Array, message: string): Promise<string> {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

async function deriveSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = createHmac("sha256", new TextEncoder().encode(`AWS4${secretKey}`)).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update(service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  return kSigning;
}

function formatAmzDate(now: Date): string {
  return now.toISOString().replace(/[\-:]/g, "").slice(0, 15) + "Z";
}

function formatDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}
