// LAMA-321: trash-card copy — the confirmation must name the EXACT folder/
// trash prefix and state the deletion is permanent/irreversible.

import { describe, expect, test } from "bun:test";
import {
  EMPTY_TRASH_CONFIRM_LABEL,
  EMPTY_TRASH_PERMANENT_COPY,
  EMPTY_TRASH_TITLE,
  trashCardSummary,
  trashLocationPath,
} from "./trash.ts";

describe("trashLocationPath", () => {
  test("joins the listing path with the detected prefix", () => {
    expect(trashLocationPath("work", ".Trash-1000")).toBe("work/.Trash-1000");
    expect(trashLocationPath("", ".Trash-1000")).toBe(".Trash-1000");
    expect(trashLocationPath("", ".Trash/1000")).toBe(".Trash/1000");
    expect(trashLocationPath("a/b", ".Trash/1000")).toBe("a/b/.Trash/1000");
  });

  test("tolerates trailing slashes from breadcrumb navigation", () => {
    expect(trashLocationPath("work/", ".Trash-1000")).toBe("work/.Trash-1000");
    expect(trashLocationPath("a/b/", ".Trash/1000")).toBe("a/b/.Trash/1000");
  });
});

describe("empty-trash confirmation copy", () => {
  test("titles and confirm label name the action", () => {
    expect(EMPTY_TRASH_TITLE).toBe("Empty trash");
    expect(EMPTY_TRASH_CONFIRM_LABEL).toBe("Empty trash");
  });

  test("permanence sentence says permanent and irreversible", () => {
    expect(EMPTY_TRASH_PERMANENT_COPY.toLowerCase()).toContain("permanent");
    expect(EMPTY_TRASH_PERMANENT_COPY.toLowerCase()).toContain("irreversible");
    expect(EMPTY_TRASH_PERMANENT_COPY.toLowerCase()).toContain("recovered");
  });
});

describe("trashCardSummary", () => {
  test("includes location and owner uid", () => {
    expect(trashCardSummary("vault/.Trash-1000", 1000, null, null, null)).toBe(
      "vault/.Trash-1000 — user 1000, size not measured",
    );
  });

  test("includes object count and bytes when measured", () => {
    expect(trashCardSummary(".Trash/1000", 1000, 153, 3, 1700000000000)).toBe(
      ".Trash/1000 — user 1000, 3 objects, 153 bytes",
    );
  });
});
