// Tests for the hand-rolled argv parser used by the LAMA-229 CLI. Pure —
// no I/O, no FFI, no shared state.

import { describe, expect, test } from "bun:test";

import {
  CliUsageError,
  flagBool,
  flagString,
  flagStrings,
  parseArgs,
  requireFlagString,
  wantJson,
} from "./args.ts";

describe("parseArgs", () => {
  test("collects positional words and groups flags", () => {
    const result = parseArgs(["folders", "list", "--json"]);
    expect(result.command).toEqual(["folders", "list"]);
    expect(result.flags).toEqual({ json: true });
  });

  test("supports --flag=value and --flag value (string and short)", () => {
    const result = parseArgs([
      "backends",
      "create",
      "--name=b1",
      "--kind",
      "s3",
      "-j",
      "--s3-endpoint",
      "https://example.com",
    ]);
    expect(result.command).toEqual(["backends", "create"]);
    expect(result.flags).toEqual({
      name: "b1",
      kind: "s3",
      j: true,
      "s3-endpoint": "https://example.com",
    });
  });

  test("'--' ends flag parsing; subsequent words are positionals/rest", () => {
    const result = parseArgs([
      "ops",
      "list",
      "--",
      "--not-a-flag",
      "value",
    ]);
    // After `--` the parser stops flag-parsing; bare words go into `rest`.
    expect(result.command).toEqual(["ops", "list"]);
    expect(result.rest).toEqual(["--not-a-flag", "value"]);
    expect(result.flags).toEqual({});
  });

  test("positionals beyond the depth-2 command tree go to `rest`", () => {
    const result = parseArgs([
      "folders",
      "assign",
      "folder-id-1",
      "--host",
      "h1",
      "--path",
      "/data/lf",
    ]);
    expect(result.command).toEqual(["folders", "assign"]);
    expect(result.rest).toEqual(["folder-id-1"]);
    expect(result.flags).toEqual({
      host: "h1",
      path: "/data/lf",
    });
  });

  test("boolean flags with no value become true", () => {
    const result = parseArgs(["sync", "fid", "--host", "h1", "--dry-run"]);
    expect(result.flags).toMatchObject({ host: "h1", "dry-run": true });
  });

  test("repeated flags collect into an array", () => {
    const result = parseArgs([
      "folders",
      "create",
      "--ignore",
      "a",
      "--ignore=b",
      "--ignore",
      "c",
    ]);
    expect(flagStrings(result.flags, "ignore")).toEqual(["a", "b", "c"]);
  });
});

describe("flagString / requireFlagString / flagBool / wantJson", () => {
  test("flagString returns the value when set", () => {
    expect(flagString({ k: "v" }, "k")).toBe("v");
    expect(flagString({ k: true }, "k")).toBeUndefined();
    expect(flagString({ x: "y" }, "missing")).toBeUndefined();
  });

  test("flagString rejects empty values", () => {
    expect(() => flagString({ k: "" }, "k")).toThrow(CliUsageError);
  });

  test("requireFlagString throws on missing", () => {
    expect(() => requireFlagString({}, "k")).toThrow(CliUsageError);
  });

  test("flagBool returns true when the flag is present", () => {
    expect(flagBool({ k: true }, "k")).toBe(true);
    expect(flagBool({ k: "value" }, "k")).toBe(true);
    expect(flagBool({}, "k")).toBe(false);
  });

  test("wantJson recognises both --json and -j", () => {
    expect(wantJson({ json: true })).toBe(true);
    expect(wantJson({ j: true })).toBe(true);
    expect(wantJson({})).toBe(false);
  });
});
