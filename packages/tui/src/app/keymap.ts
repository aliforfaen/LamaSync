import type { KeyEvent } from "@opentui/core";

export type { KeyEvent } from "@opentui/core";

/**
 * A single hotkey: a printable character (or a named non-printable key like
 * `escape`, `tab`, `leftbracket`) paired with a label and a runnable.
 *
 * `run` may be sync or async; the dispatcher awaits its result before
 * continuing so view-level state mutations happen deterministically.
 */
export interface Hotkey {
  readonly key: string;
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

/**
 * Match a single key event against a view's hotkey table.
 *
 * Matching order:
 *   1. By `char` — the literal printable character. The match is
 *      case-insensitive so views can register lowercase keys and still
 *      accept uppercase input from the terminal.
 *   2. By `name` — OpenTUI's named non-printable key (`escape`, `tab`,
 *      `leftbracket`, `rightbracket`, `return`, `backspace`, …). The match
 *      is case-insensitive to tolerate how various terminals report names.
 *
 * Returns `undefined` when `hotkeys` is empty so callers can short-circuit
 * cleanly.
 */
export function matchHotkey(
  hotkeys: ReadonlyArray<Hotkey>,
  name: string,
  char: string,
): Hotkey | undefined {
  if (hotkeys.length === 0) return undefined;
  if (char.length > 0) {
    const lowerChar = char.toLowerCase();
    const byChar = hotkeys.find((h) => h.key === lowerChar);
    if (byChar) return byChar;
  }
  const lowerName = name.toLowerCase();
  return hotkeys.find((h) => h.key.toLowerCase() === lowerName);
}
