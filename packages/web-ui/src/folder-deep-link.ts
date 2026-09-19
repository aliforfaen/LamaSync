// LAMA-345 follow-up — Folders deep links (`/folders?folder=<id>&host=<id>`).
//
// The Fleet health card links to a folder assignment, so the Folders page has
// to honour that URL: open the folder, land on the requested device's health
// card and put focus there. Everything here is pure so the rules — parameter
// parsing, the fallback when a device is missing, and the "apply once per
// navigation" guard — are testable without a DOM or a router.

/** A `?folder=&host=` pair as it appears in the URL (host optional). */
export interface FolderDeepLink {
  folderId: string;
  hostId: string | null;
}

/** The minimum a loaded folder row must expose to resolve a deep link. */
export interface FolderDeepLinkFolder {
  folder: { id: string };
  assignments: readonly { hostId: string }[];
}

/** Where a valid deep link should land. */
export interface FolderDeepLinkTarget {
  /** The folder to open. Always a folder that exists in the current list. */
  folderId: string;
  /** The assignment to land on — the requested device, else the first one. */
  hostId: string | null;
  /** What the URL actually asked for, before any fallback. */
  requestedHostId: string | null;
  /** True when the URL named a device that is not set up on this folder. */
  fellBackToFirstHost: boolean;
}

/** A URL-supplied id longer than this is never a real folder/device id. */
export const DEEP_LINK_ID_MAX_LENGTH = 200;

/**
 * Normalise one URL-supplied id.
 *
 * `URLSearchParams` has already percent-decoded the value, so this must NOT
 * decode again (a literal `%` in an id would be corrupted). Rejects empty,
 * whitespace-only, oversized and control-character input; callers treat a null
 * as "no id given".
 */
export function decodeDeepLinkId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > DEEP_LINK_ID_MAX_LENGTH) return null;
  // Control characters never appear in an id and could confuse logs/ARIA text.
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}

/** Parse `location.search` into a deep link, or null when no usable folder id. */
export function parseFolderDeepLink(search: string): FolderDeepLink | null {
  const params = new URLSearchParams(search);
  const folderId = decodeDeepLinkId(params.get("folder"));
  if (folderId === null) return null;
  return { folderId, hostId: decodeDeepLinkId(params.get("host")) };
}

/**
 * Resolve a parsed link against the loaded folders.
 *
 * Returns null when the folder is not in the list (removed, or a stale link) so
 * the caller can leave the table exactly as it is. A missing or unknown device
 * falls back to the folder's first assignment rather than refusing the link —
 * opening the right folder is more useful than opening nothing.
 */
export function resolveFolderDeepLink(
  link: FolderDeepLink | null,
  folders: readonly FolderDeepLinkFolder[],
): FolderDeepLinkTarget | null {
  if (link === null) return null;
  const match = folders.find((entry) => entry.folder.id === link.folderId);
  if (!match) return null;
  const hostIds = match.assignments.map((assignment) => assignment.hostId);
  if (link.hostId !== null) {
    if (hostIds.includes(link.hostId)) {
      return {
        folderId: link.folderId,
        hostId: link.hostId,
        requestedHostId: link.hostId,
        fellBackToFirstHost: false,
      };
    }
    return {
      folderId: link.folderId,
      hostId: hostIds[0] ?? null,
      requestedHostId: link.hostId,
      fellBackToFirstHost: hostIds.length > 0,
    };
  }
  return {
    folderId: link.folderId,
    hostId: hostIds[0] ?? null,
    requestedHostId: null,
    fellBackToFirstHost: false,
  };
}

/**
 * Navigation identity for a deep link.
 *
 * The router's `location.key` changes on every navigation — including a second
 * click on the same link and back/forward — while the parsed link stays the
 * same. Keying the "apply" guard on the pair is what makes a repeat click move
 * the page again without re-scrolling on every re-render.
 *
 * Takes the PARSED link (not the resolved target) so a link that cannot be
 * resolved is still a handled navigation: the page must clear a stale target
 * and explain, rather than ignore the click. Returns null when the URL carries
 * no folder parameter at all, which leaves the operator where they were.
 */
export function folderDeepLinkToken(
  locationKey: string,
  link: FolderDeepLink | null,
): string | null {
  if (link === null) return null;
  return `${locationKey}|${link.folderId}|${link.hostId ?? ""}`;
}

export interface FoldersDeepLinkState {
  /** The token already applied; null before the first one. */
  handledToken: string | null;
  /** Folder the deep link opened. */
  expandedFolderId: string | null;
  /** Assignment to scroll to and focus, when it has one. */
  focusHostId: string | null;
}

export const EMPTY_FOLDERS_DEEP_LINK: FoldersDeepLinkState = {
  handledToken: null,
  expandedFolderId: null,
  focusHostId: null,
};

/**
 * Fold one navigation into the deep-link state.
 *
 * Cases, all returning the SAME object when there is nothing to do so React
 * bails out of the re-render and the scroll effect cannot fire twice for one
 * navigation:
 *   - no folder parameter (token null): leave the operator where they were.
 *     Landing on `/folders` must not collapse what they opened.
 *   - the folder list has not loaded yet: wait. A null target is not yet a
 *     verdict, and consuming the navigation now would lose the link.
 *   - a link that resolves: open that folder and mark the assignment to focus.
 *   - a link that does NOT resolve (removed folder, or a device that is not set
 *     up on it): record the navigation and CLEAR the focus target so a stale
 *     highlight from the previous link cannot linger, while leaving the open
 *     folder alone rather than yanking the table around.
 */
export function applyFolderDeepLink(
  prev: FoldersDeepLinkState,
  input: {
    token: string | null;
    target: FolderDeepLinkTarget | null;
    /**
     * True once the folder list has loaded. Until then a null target means
     * "not known yet", not "does not exist" — recording the navigation early
     * would consume it and the link would never open anything.
     */
    ready: boolean;
  },
): FoldersDeepLinkState {
  if (input.token === null) return prev;
  if (!input.ready) return prev;
  if (prev.handledToken === input.token) return prev;
  if (input.target === null) {
    return { handledToken: input.token, expandedFolderId: prev.expandedFolderId, focusHostId: null };
  }
  return {
    handledToken: input.token,
    expandedFolderId: input.target.folderId,
    focusHostId: input.target.hostId,
  };
}

/**
 * A short sentence for a link that could not be honoured, or null when there is
 * nothing to say. A silent no-op looks like a broken link, so the page says
 * what happened — without ever blocking the table.
 */
export function deepLinkNotice(
  link: FolderDeepLink | null,
  target: FolderDeepLinkTarget | null,
  options: { visibleFolderIds?: readonly string[] } = {},
): string | null {
  if (link === null) return null;
  if (target === null) {
    return "That folder link could not be opened — the folder may have been removed or renamed.";
  }
  const visible = options.visibleFolderIds;
  if (visible && !visible.includes(target.folderId)) {
    // The folder exists but the device filter (or the Backups view) is hiding
    // it. The page must not change that filter behind the operator's back, so
    // it says why nothing moved instead.
    return "This folder is hidden by the current device filter — choose \u201cAll devices\u201d to open it.";
  }
  if (target.fellBackToFirstHost) {
    return "That device is not set up on this folder — showing another device instead.";
  }
  return null;
}
