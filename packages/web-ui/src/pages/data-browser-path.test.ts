// LAMA-296 stage 1 — Data Browser deep-link normalization (the mobile
// completion receipt's open path). The `path` parameter must never feed a
// traversal/absolute path into the local browser; the server validates too,
// but the client normalizes defensively.

import { describe, expect, it } from "bun:test";
import { initialBrowsePathFromParam } from "./DataBrowser.tsx";

describe("initialBrowsePathFromParam", () => {
  it("decodes a normal mobile receipt path", () => {
    expect(
      initialBrowsePathFromParam("Mobile%2Fmob-abc123%2FInbox"),
    ).toBe("Mobile/mob-abc123/Inbox");
  });

  it("maps null/absent to the root", () => {
    expect(initialBrowsePathFromParam(null)).toBe("");
  });

  it("strips leading/trailing slashes and backslashes", () => {
    expect(initialBrowsePathFromParam("/Mobile///")).toBe("Mobile");
    expect(initialBrowsePathFromParam("Mobile\\mob-a\\Inbox")).toBe("Mobile/mob-a/Inbox");
  });

  it("rejects traversal, dots and empty segments", () => {
    expect(initialBrowsePathFromParam("..%2F..%2Fetc")).toBe("");
    expect(initialBrowsePathFromParam("Mobile/../etc")).toBe("");
    expect(initialBrowsePathFromParam("Mobile/./Inbox")).toBe("");
    expect(initialBrowsePathFromParam("Mobile//Inbox")).toBe("");
  });

  it("rejects oversized and undecodable input", () => {
    expect(initialBrowsePathFromParam(`M${"x".repeat(700)}`)).toBe("");
    expect(initialBrowsePathFromParam("%zz%zz")).toBe("");
  });
});