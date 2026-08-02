import { describe, expect, test } from "bun:test";
import { signRequest, listS3Objects, S3ListObjectsError } from "./s3-list.ts";
import type { S3FolderConfig } from "@lamasync/core";

const AWS_TEST_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_TEST_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

// LAMA-222: listS3Objects consumes a fully-resolved S3FolderConfig (folder
// joined against its Backend row + decrypted secret), not the Folder itself.
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

describe("signRequest", () => {
  test("matches the published AWS SigV4 get-vanilla-query test-suite vector", async () => {
    // Official aws-sig-v4-test-suite get-vanilla-query vector (verified from
    // @saibotsivad/aws-sig-v4-test-suite index.json): GET / with NO query
    // params, signed headers host;x-amz-date. Anchors both the signature and
    // the canonical-request hash (4th line of the string-to-sign) against
    // values published in the suite.
    const result = await signRequest(
      "GET",
      "example.amazonaws.com",
      "/",
      {},
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "AKIDEXAMPLE",
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "us-east-1",
      "service",
      new Date("2015-08-30T12:36:00.000Z"),
      { "x-amz-date": "20150830T123600Z" },
    );
    expect(result.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    // 4th line of the string-to-sign is hex(sha256(canonicalRequest)).
    const canonicalRequestHash = result.stringToSign.split("\n")[3];
    expect(canonicalRequestHash).toBe(
      "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
    expect(result.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
  });

  test("produces the expected SigV4 canonical request and signature for the AWS get-vanilla-query vector", async () => {
    const now = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
    const result = await signRequest(
      "GET",
      "examplebucket.s3.amazonaws.com",
      "/",
      { Param1: "value1" },
      "UNSIGNED-PAYLOAD",
      AWS_TEST_ACCESS_KEY,
      AWS_TEST_SECRET_KEY,
      "us-east-1",
      "s3",
      now,
    );

    expect(result.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "Param1=value1",
        "host:examplebucket.s3.amazonaws.com",
        "",
        "host",
        "UNSIGNED-PAYLOAD",
      ].join("\n"),
    );

    expect(result.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20130524T000000Z",
        "20130524/us-east-1/s3/aws4_request",
        "4af41c86f9e5bb8a606f4acd4015a8bb5331dcacf404b7663060551df4b30863",
      ].join("\n"),
    );

    expect(result.signature).toBe(
      "b8e7b054e76b6c995e01df30c29e90cf97b3a9cbd768f6a7a27fdc17a9d119e3",
    );
  });

  test("uri-encodes path segments and query values", async () => {
    const now = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
    const result = await signRequest(
      "GET",
      "examplebucket.s3.amazonaws.com",
      "/path with spaces/file",
      { "key!": "value*" },
      "UNSIGNED-PAYLOAD",
      AWS_TEST_ACCESS_KEY,
      AWS_TEST_SECRET_KEY,
      "us-east-1",
      "s3",
      now,
    );
    expect(result.canonicalRequest).toContain("/path%20with%20spaces/file");
    expect(result.canonicalRequest).toContain("key%21=value%2A");
  });
});

describe("listS3Objects", () => {
  test("parses a ListObjectsV2 XML response into entries", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>test-bucket</Name>
  <Prefix>backups/</Prefix>
  <MaxKeys>1000</MaxKeys>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>backups/photo.jpg</Key>
    <LastModified>2024-01-15T10:30:00.000Z</LastModified>
    <ETag>"abc"</ETag>
    <Size>2048</Size>
  </Contents>
  <CommonPrefixes>
    <Prefix>backups/january/</Prefix>
  </CommonPrefixes>
</ListBucketResult>`;

    const fetchImpl = (): Promise<Response> => {
      return Promise.resolve(
        new Response(xml, { status: 200, headers: { "content-type": "application/xml" } }),
      );
    };

    const listing = await listS3Objects(s3Config(), "backups/", 1000, fetchImpl);
    expect(listing.entries).toHaveLength(2);
    expect(listing.entries).toContainEqual({
      name: "photo.jpg",
      type: "file",
      size: 2048,
      lastModified: Date.parse("2024-01-15T10:30:00.000Z"),
    });
    expect(listing.entries).toContainEqual({
      name: "january",
      type: "dir",
      size: 0,
      lastModified: 0,
    });
  });

  test("throws S3ListObjectsError for a 4xx response", async () => {
    const fetchImpl = (): Promise<Response> => {
      return Promise.resolve(
        new Response("Access Denied", { status: 403, statusText: "Forbidden" }),
      );
    };

    await expect(listS3Objects(s3Config(), "", 1000, fetchImpl)).rejects.toBeInstanceOf(
      S3ListObjectsError,
    );
  });

  test("throws S3ListObjectsError for a network failure", async () => {
    const fetchImpl = (): Promise<Response> => {
      return Promise.reject(new TypeError("fetch failed"));
    };

    await expect(listS3Objects(s3Config(), "", 1000, fetchImpl)).rejects.toBeInstanceOf(
      S3ListObjectsError,
    );
  });

  test("rejects prefixes containing traversal", async () => {
    await expect(listS3Objects(s3Config(), "../etc", 1000)).rejects.toBeInstanceOf(
      S3ListObjectsError,
    );
  });
});
