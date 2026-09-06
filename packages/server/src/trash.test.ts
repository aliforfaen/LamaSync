// LAMA-321: trash detection must recognize ONLY the two exact freedesktop
// layouts — `.Trash-<uid>` and `.Trash/<uid>` — and never lookalikes,
// files, or traversal shapes. Pure tests over the detection helpers.

import { describe, expect, test } from "bun:test";
import {
  directTrashCandidates,
  nestedTrashCandidates,
  parseTrashUid,
  sortTrashItems,
  type TrashLikeEntry,
} from "./trash.ts";

function dir(name: string): TrashLikeEntry {
  return { name, type: "dir" };
}
function file(name: string): TrashLikeEntry {
  return { name, type: "file" };
}

describe("parseTrashUid", () => {
  test("accepts numeric uids incl. 0 and large-but-safe integers", () => {
    expect(parseTrashUid("1000")).toBe(1000);
    expect(parseTrashUid("0")).toBe(0);
    expect(parseTrashUid("4294967294")).toBe(4294967294);
  });

  test("rejects non-numeric, negative, empty, and overflow uids", () => {
    expect(parseTrashUid("")).toBeNull();
    expect(parseTrashUid("abc")).toBeNull();
    expect(parseTrashUid("1000x")).toBeNull();
    expect(parseTrashUid("-1")).toBeNull();
    expect(parseTrashUid("1.5")).toBeNull();
    expect(parseTrashUid("99999999999999999999")).toBeNull();
  });
});

describe("directTrashCandidates", () => {
  test("detects .Trash-1000 and .Trash-1001 directories", () => {
    const { items, hasDotTrash } = directTrashCandidates([
      dir(".Trash-1000"),
      dir(".Trash-1001"),
      dir("work"),
    ]);
    expect(hasDotTrash).toBe(false);
    expect(items).toEqual([
      { uid: 1000, prefix: ".Trash-1000" },
      { uid: 1001, prefix: ".Trash-1001" },
    ]);
  });

  test("flags a .Trash directory for the nested peek", () => {
    const { items, hasDotTrash } = directTrashCandidates([dir(".Trash"), dir("x")]);
    expect(hasDotTrash).toBe(true);
    expect(items).toEqual([]);
  });

  test("never treats lookalikes as trash", () => {
    const { items, hasDotTrash } = directTrashCandidates([
      dir(".Trash-1000x"),
      dir(".Trash1000"),
      dir(".Trash--1000"),
      dir(".trash-1000"),
      dir(".Trash"),
      dir(".Trash-abc"),
    ]);
    expect(hasDotTrash).toBe(true); // the genuine ".Trash" dir still peeks
    expect(items).toEqual([]);
  });

  test("a file named .Trash-1000 is not trash", () => {
    const { items } = directTrashCandidates([file(".Trash-1000")]);
    expect(items).toEqual([]);
  });
});

describe("nestedTrashCandidates", () => {
  test("detects valid .Trash/<uid> children", () => {
    expect(nestedTrashCandidates([dir("1000"), dir("1001")])).toEqual([
      { uid: 1000, prefix: ".Trash/1000" },
      { uid: 1001, prefix: ".Trash/1001" },
    ]);
  });

  test("rejects non-numeric children, files, and traversal names", () => {
    expect(
      nestedTrashCandidates([
        dir("1000x"),
        file("1000"),
        dir(".."),
        dir(".Trash"),
        dir("1000/.."),
      ]),
    ).toEqual([]);
  });
});

describe("sortTrashItems", () => {
  test("orders by prefix deterministically", () => {
    expect(
      sortTrashItems([
        { uid: 1000, prefix: ".Trash/1000" },
        { uid: 1000, prefix: ".Trash-1000" },
        { uid: 1001, prefix: ".Trash-1001" },
      ]),
    ).toEqual([
      { uid: 1000, prefix: ".Trash-1000" },
      { uid: 1001, prefix: ".Trash-1001" },
      { uid: 1000, prefix: ".Trash/1000" },
    ]);
  });
});
