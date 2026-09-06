// LAMA-321: recursive prefix sizing must paginate ListObjectsV2 past the
// 1000-key page cap, aggregate object counts + bytes across pages, and keep
// scrubbing errors. Pure network tests — ListObjectsV2 responses are faked.

import { describe, expect, test } from "bun:test";
import { sizeS3Prefix, S3ListObjectsError } from "./s3-list.ts";
import type { S3FolderConfig } from "@lamasync/core";

const AWS_TEST_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_TEST_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function s3Config(overrides: Partial<S3FolderConfig> = {}): S3FolderConfig {
  return {
    folderId: "folder-1",
    backendId: "backend-1",
    provider: "other",
    endpoint: "s3.example.com",
    bucket: "test-bucket",
    accessKeyId: AWS_TEST_ACCESS_KEY,
    secretAccessKey: AWS_TEST_SECRET_KEY,
    region: "us-east-1",
    ...overrides,
  };
}

function contentXml(key: string, size: number): string {
  return `<Contents><Key>${key}</Key><LastModified>2024-01-15T10:30:00.000Z</LastModified><Size>${size}</Size></Contents>`;
}

function pageXml(
  prefix: string,
  contents: string,
  truncated: boolean,
  nextToken?: string,
): string {
  const token = truncated
    ? `<NextContinuationToken>${nextToken ?? ""}</NextContinuationToken>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>test-bucket</Name>
  <Prefix>${prefix}</Prefix>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>${truncated}</IsTruncated>
  ${token}
  ${contents}
</ListBucketResult>`;
}

describe("sizeS3Prefix", () => {
  test("aggregates >1000 objects across continuation-token pages", async () => {
    const requested: string[] = [];
    const fetchImpl = (url: string | URL | Request): Promise<Response> => {
      const parsed = new URL(url.toString());
      requested.push(parsed.searchParams.get("continuation-token") ?? "");
      const page = parsed.searchParams.get("continuation-token") === "TOKEN1" ? 1 : 0;
      const prefix = parsed.searchParams.get("prefix") ?? "";
      if (page === 0) {
        const xml = pageXml(
          prefix,
          Array.from({ length: 1000 }, (_, i) =>
            contentXml(`${prefix}file-${String(i).padStart(4, "0")}.bin`, 1 + (i % 7)),
          ).join(""),
          true,
          "TOKEN1",
        );
        return Promise.resolve(new Response(xml, { status: 200 }));
      }
      const xml = pageXml(
        prefix,
        `${contentXml(`${prefix}tail-1.bin`, 42)}${contentXml(`${prefix}tail-2.bin`, 8)}`,
        false,
      );
      return Promise.resolve(new Response(xml, { status: 200 }));
    };

    const result = await sizeS3Prefix(s3Config(), ".Trash-1000/", fetchImpl);

    // 1000 page-one objects + 2 page-two objects; bytes = 1000*1 + 7-sum
    // pattern (each of the 1000 first-page objects is 1..7 bytes), plus 50.
    const firstPageBytes = Array.from({ length: 1000 }, (_, i) => 1 + (i % 7)).reduce(
      (sum, n) => sum + n,
      0,
    );
    expect(result.objectCount).toBe(1002);
    expect(result.bytes).toBe(firstPageBytes + 50);
    // The paginator must have followed the continuation token exactly once.
    expect(requested).toEqual(["", "TOKEN1"]);
  });

  test("reports zeroes for an empty prefix", async () => {
    const fetchImpl = (url: string | URL | Request): Promise<Response> => {
      const prefix = new URL(url.toString()).searchParams.get("prefix") ?? "";
      return Promise.resolve(
        new Response(pageXml(prefix, "", false), { status: 200 }),
      );
    };
    const result = await sizeS3Prefix(s3Config(), "empty-dir/", fetchImpl);
    expect(result).toEqual({ objectCount: 0, bytes: 0 });
  });

  test("never sends a delimiter for recursive listing", async () => {
    const fetchImpl = (url: string | URL | Request): Promise<Response> => {
      const parsed = new URL(url.toString());
      expect(parsed.searchParams.has("delimiter")).toBe(false);
      expect(parsed.searchParams.get("prefix")).toBe(".Trash-1000/");
      return Promise.resolve(
        new Response(pageXml(".Trash-1000/", "", false), { status: 200 }),
      );
    };
    await sizeS3Prefix(s3Config(), ".Trash-1000/", fetchImpl);
  });

  test("rejects traversal prefixes", async () => {
    await expect(
      sizeS3Prefix(s3Config(), "../etc", () => Promise.resolve(new Response("", { status: 200 }))),
    ).rejects.toBeInstanceOf(S3ListObjectsError);
  });

  test("rejects a 403 with an S3ListObjectsError", async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.resolve(
        new Response("AccessDenied: secret-bucket-detail", { status: 403 }),
      );
    await expect(
      sizeS3Prefix(s3Config(), ".Trash-1000/", fetchImpl),
    ).rejects.toBeInstanceOf(S3ListObjectsError);
  });

  test("rejects a network failure with an S3ListObjectsError", async () => {
    const fetchImpl = (): Promise<Response> =>
      Promise.reject(new TypeError("fetch failed"));
    await expect(
      sizeS3Prefix(s3Config(), ".Trash-1000/", fetchImpl),
    ).rejects.toBeInstanceOf(S3ListObjectsError);
  });
});
