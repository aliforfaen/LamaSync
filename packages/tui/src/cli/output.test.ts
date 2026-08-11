// Tests for the CLI's output helpers: secret masking and secret-aware
// deep-walk over JSON-serialisable values. Pure — no I/O.

import { describe, expect, test } from "bun:test";

import { maskSecret, maskSecretsDeep } from "./output.ts";

describe("maskSecret (LAMA-229 safety rule 4)", () => {
  test("masks long strings as first-8 + ellipsis + last-4", () => {
    expect(maskSecret("lamasync_xxab-cd1234ef567890ghijkl"))
      .toBe("lamasync…ijkl");
  });

  test("returns fully-redacted form for short inputs", () => {
    expect(maskSecret("abcd")).toBe("…");
    expect(maskSecret("123456789012")).toBe("…");
  });

  test("empty / nullish inputs stay empty", () => {
    expect(maskSecret("")).toBe("");
    expect(maskSecret(null)).toBe("");
    expect(maskSecret(undefined)).toBe("");
  });
});

describe("maskSecretsDeep", () => {
  test("masks s3 secret fields deeply", () => {
    const input = {
      s3Provider: "exoscale",
      s3AccessKeyId: "AKIA1234",
      s3SecretAccessKey: "lamasync_super_secret_key_99",
      creds: {
        apiKey: "lamasync_xyz_another_secret",
        resticPassword: "restic-pass-99",
      },
      list: [{ s3SecretAccessKey: "another-secret" }],
    };
    const out = maskSecretsDeep(input) as Record<string, unknown>;
    expect(out.s3SecretAccessKey).toBe("lamasync…y_99");
    expect(out.s3AccessKeyId).toBe("AKIA1234");
    const nested = out.creds as Record<string, string>;
    expect(nested.apiKey).toBe("lamasync…cret");
    expect(nested.resticPassword).toBe("restic-p…s-99");
    expect((out.list as Array<Record<string, string>>)[0]?.s3SecretAccessKey).toBe(
      "another-…cret",
    );
  });

  test("passes through non-secret fields unchanged", () => {
    expect(maskSecretsDeep({ a: 1, b: "two", c: null })).toEqual({
      a: 1,
      b: "two",
      c: null,
    });
  });

  test("handles cycles without crashing", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", parent: a };
    a.child = b;
    // Just ensure no stack overflow / infinite loop. Masking only kicks
    // in on known secret keys, so the rest of the structure passes through.
    const out = maskSecretsDeep(a) as unknown as Record<string, unknown>;
    expect(out.name).toBe("a");
  });
});
