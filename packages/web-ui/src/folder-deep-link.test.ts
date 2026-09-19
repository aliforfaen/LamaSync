// LAMA-345 follow-up — Folders deep links.
//
// Browser-proven gap this closes: the Fleet health card emitted
// `/folders?folder=<id>&host=<id>`, the URL was correct, and nothing happened —
// the requested assignment stayed collapsed. These tests pin the parsing, the
// device fallback, the invalid-input behaviour and the "apply once per
// navigation" guard that makes repeat clicks and back/forward work.

import { describe, expect, test } from "bun:test";
import {
  DEEP_LINK_ID_MAX_LENGTH,
  EMPTY_FOLDERS_DEEP_LINK,
  applyFolderDeepLink,
  decodeDeepLinkId,
  deepLinkNotice,
  folderDeepLinkToken,
  parseFolderDeepLink,
  resolveFolderDeepLink,
  type FolderDeepLinkFolder,
} from "./folder-deep-link.ts";

const FOLDER_A = "7dff3729-c493-4f5b-891b-176f56ad84a6";
const FOLDER_B = "ff4e7bfd-20cf-4029-b374-4cc4f0a28ed3";
const HOST_A = "dev-vm";
const HOST_B = "cachy";

function folders(): FolderDeepLinkFolder[] {
  return [
    { folder: { id: FOLDER_A }, assignments: [{ hostId: HOST_A }, { hostId: HOST_B }] },
    { folder: { id: FOLDER_B }, assignments: [] },
  ];
}

describe("parseFolderDeepLink", () => {
  test("reads an encoded folder+host pair", () => {
    const search = `?folder=${encodeURIComponent(FOLDER_A)}&host=${encodeURIComponent(HOST_A)}`;
    expect(parseFolderDeepLink(search)).toEqual({ folderId: FOLDER_A, hostId: HOST_A });
  });

  test("tolerates a missing leading question mark and extra parameters", () => {
    expect(parseFolderDeepLink(`folder=${FOLDER_A}&ref=health&host=${HOST_A}`)).toEqual({
      folderId: FOLDER_A,
      hostId: HOST_A,
    });
  });

  test("a folder without a host is a valid folder-only link", () => {
    expect(parseFolderDeepLink(`?folder=${FOLDER_A}`)).toEqual({
      folderId: FOLDER_A,
      hostId: null,
    });
  });

  test("a link without a folder is not a deep link", () => {
    expect(parseFolderDeepLink("")).toBeNull();
    expect(parseFolderDeepLink("?host=dev-vm")).toBeNull();
    expect(parseFolderDeepLink("?folder=")).toBeNull();
    expect(parseFolderDeepLink("?folder=%20%20")).toBeNull();
  });

  test("an id is NOT decoded twice", () => {
    // `URLSearchParams` already percent-decoded this to `a%b`; decoding again
    // would throw and silently drop a legitimate id.
    expect(parseFolderDeepLink("?folder=a%25b")).toEqual({ folderId: "a%b", hostId: null });
  });
});

describe("decodeDeepLinkId", () => {
  test("rejects absent, empty, oversized and control-character values", () => {
    expect(decodeDeepLinkId(null)).toBeNull();
    expect(decodeDeepLinkId(undefined)).toBeNull();
    expect(decodeDeepLinkId("")).toBeNull();
    expect(decodeDeepLinkId("   ")).toBeNull();
    expect(decodeDeepLinkId("x".repeat(DEEP_LINK_ID_MAX_LENGTH + 1))).toBeNull();
    expect(decodeDeepLinkId("ok\u0000bad")).toBeNull();
    expect(decodeDeepLinkId("ok\nbad")).toBeNull();
  });

  test("trims surrounding whitespace and keeps real ids intact", () => {
    expect(decodeDeepLinkId("  dev-vm  ")).toBe("dev-vm");
    expect(decodeDeepLinkId(FOLDER_A)).toBe(FOLDER_A);
  });
});

describe("resolveFolderDeepLink", () => {
  test("valid folder + host targets that exact assignment", () => {
    expect(resolveFolderDeepLink({ folderId: FOLDER_A, hostId: HOST_B }, folders())).toEqual({
      folderId: FOLDER_A,
      hostId: HOST_B,
      requestedHostId: HOST_B,
      fellBackToFirstHost: false,
    });
  });

  test("folder only falls back to the first assignment", () => {
    expect(resolveFolderDeepLink({ folderId: FOLDER_A, hostId: null }, folders())).toEqual({
      folderId: FOLDER_A,
      hostId: HOST_A,
      requestedHostId: null,
      fellBackToFirstHost: false,
    });
  });

  test("an unknown host falls back to the first assignment and says so", () => {
    const target = resolveFolderDeepLink({ folderId: FOLDER_A, hostId: "ghost" }, folders());
    expect(target?.hostId).toBe(HOST_A);
    expect(target?.fellBackToFirstHost).toBe(true);
    expect(deepLinkNotice({ folderId: FOLDER_A, hostId: "ghost" }, target)).toContain(
      "not set up on this folder",
    );
  });

  test("an unknown folder is refused outright", () => {
    expect(resolveFolderDeepLink({ folderId: "nope", hostId: HOST_A }, folders())).toBeNull();
    expect(deepLinkNotice({ folderId: "nope", hostId: HOST_A }, null)).toContain(
      "could not be opened",
    );
  });

  test("a folder with no assignments resolves to the folder with no focus target", () => {
    expect(resolveFolderDeepLink({ folderId: FOLDER_B, hostId: HOST_A }, folders())).toEqual({
      folderId: FOLDER_B,
      hostId: null,
      requestedHostId: HOST_A,
      fellBackToFirstHost: false,
    });
  });

  test("no link and an empty folder list are both no-ops", () => {
    expect(resolveFolderDeepLink(null, folders())).toBeNull();
    expect(resolveFolderDeepLink({ folderId: FOLDER_A, hostId: null }, [])).toBeNull();
  });

  test("a folder hidden by the device filter is explained, not silently skipped", () => {
    const link = { folderId: FOLDER_A, hostId: HOST_A };
    const target = resolveFolderDeepLink(link, folders());
    expect(deepLinkNotice(link, target, { visibleFolderIds: [FOLDER_B] })).toContain(
      "hidden by the current device filter",
    );
    // Still visible → no notice.
    expect(deepLinkNotice(link, target, { visibleFolderIds: [FOLDER_A] })).toBeNull();
    // An unknown folder is reported as missing, not as filtered.
    expect(
      deepLinkNotice({ folderId: "nope", hostId: null }, null, { visibleFolderIds: [FOLDER_A] }),
    ).toContain("could not be opened");
  });

  test("no notice when the link resolved exactly", () => {
    expect(
      deepLinkNotice({ folderId: FOLDER_A, hostId: HOST_A }, resolveFolderDeepLink({ folderId: FOLDER_A, hostId: HOST_A }, folders())),
    ).toBeNull();
    expect(deepLinkNotice(null, null)).toBeNull();
  });
});

describe("folderDeepLinkToken", () => {
  const link = { folderId: FOLDER_A, hostId: HOST_A };

  test("is null when the URL carries no folder parameter", () => {
    expect(folderDeepLinkToken("nav-1", null)).toBeNull();
  });

  test("changes per navigation, so a repeat click moves the page again", () => {
    const first = folderDeepLinkToken("nav-1", link);
    const second = folderDeepLinkToken("nav-2", link);
    expect(first).not.toBe(second);
  });

  test("changes when the query changes and differs by host", () => {
    expect(folderDeepLinkToken("nav-1", link)).not.toBe(
      folderDeepLinkToken("nav-1", { ...link, hostId: HOST_B }),
    );
    expect(folderDeepLinkToken("nav-1", link)).not.toBe(
      folderDeepLinkToken("nav-1", { ...link, folderId: FOLDER_B }),
    );
  });

  test("a link that cannot be resolved is still a handled navigation", () => {
    // Same folder in the URL, but the folder is gone: the token still changes
    // so the page clears its stale target instead of ignoring the click.
    expect(folderDeepLinkToken("nav-2", { folderId: "gone", hostId: null })).toBeTruthy();
  });
});

describe("applyFolderDeepLink", () => {
  const target = {
    folderId: FOLDER_A,
    hostId: HOST_A,
    requestedHostId: HOST_A,
    fellBackToFirstHost: false,
  };

  test("applies the first navigation", () => {
    const state = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target,
      ready: true,
    });
    expect(state).toEqual({
      handledToken: "nav-1|a",
      expandedFolderId: FOLDER_A,
      focusHostId: HOST_A,
    });
  });

  test("re-applying the same token returns the SAME object (no re-render, no re-scroll)", () => {
    const first = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target,
      ready: true,
    });
    const again = applyFolderDeepLink(first, { token: "nav-1|a", target, ready: true });
    expect(again).toBe(first);
  });

  test("while the folder list is loading, the navigation is NOT consumed", () => {
    // Browser-proven regression: recording the token before the list arrived
    // meant the link never opened anything once the folders appeared.
    const waiting = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target: null,
      ready: false,
    });
    expect(waiting).toBe(EMPTY_FOLDERS_DEEP_LINK);
    const arrived = applyFolderDeepLink(waiting, { token: "nav-1|a", target, ready: true });
    expect(arrived).toEqual({
      handledToken: "nav-1|a",
      expandedFolderId: FOLDER_A,
      focusHostId: HOST_A,
    });
  });

  test("a query change re-applies — including a different host on the same folder", () => {
    const first = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target,
      ready: true,
    });
    const moved = applyFolderDeepLink(first, {
      token: "nav-2|a",
      target: { ...target, hostId: HOST_B },
      ready: true,
    });
    expect(moved.focusHostId).toBe(HOST_B);
    expect(moved).not.toBe(first);
  });

  test("a second link in the same mounted page re-applies to the new folder", () => {
    const first = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target,
      ready: true,
    });
    const second = applyFolderDeepLink(first, {
      token: "nav-2|b",
      target: { ...target, folderId: FOLDER_B, hostId: null },
      ready: true,
    });
    expect(second).toEqual({
      handledToken: "nav-2|b",
      expandedFolderId: FOLDER_B,
      focusHostId: null,
    });
  });

  test("a navigation with no usable link leaves the operator where they were", () => {
    const first = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target,
      ready: true,
    });
    // Back to /folders with no parameters: do NOT collapse what was opened.
    expect(applyFolderDeepLink(first, { token: null, target: null, ready: true })).toBe(first);
  });

  test("an unresolvable link never expands anything on its own", () => {
    expect(
      applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
        token: "nav-9|x",
        target: null,
        ready: true,
      }),
    ).toEqual({ handledToken: "nav-9|x", expandedFolderId: null, focusHostId: null });
  });

  test("an unresolvable link clears a stale target without collapsing the folder", () => {
    // The browser-proven case: the operator followed a good link (folder A
    // expanded, assignment highlighted), then a second navigation carried a
    // link to a folder that no longer exists. The highlight must not linger.
    const applied = applyFolderDeepLink(EMPTY_FOLDERS_DEEP_LINK, {
      token: "nav-1|a",
      target,
      ready: true,
    });
    const stale = applyFolderDeepLink(applied, { token: "nav-2|gone", target: null, ready: true });
    expect(stale.focusHostId).toBeNull();
    // The already-open folder stays open — the page does not yank the table.
    expect(stale.expandedFolderId).toBe(FOLDER_A);
    expect(stale).not.toBe(applied);
  });
});
