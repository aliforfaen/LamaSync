/**
 * Themed string constants used by the TUI shell and views.
 *
 * Visual rules (text-only, consistent with the existing per-view header/footer
 * formatting):
 *   - Title bar: `LamaSync — <tab>`
 *   - Status prefixes: `[i] ` for info, `[!] ` for errors, `[ok] ` for success
 *
 * Colors, borders, and emphasis live on individual OpenTUI renderables — this
 * file deliberately holds only the strings the shell reuses across views.
 */

export interface Theme {
  readonly title: string;
  readonly header: string;
  readonly footer: string;
  readonly statusInfo: string;
  readonly statusError: string;
  readonly statusSuccess: string;
}

export const THEME: Theme = {
  title: "LamaSync",
  header: "LamaSync — ",
  footer: "",
  statusInfo: "[i] ",
  statusError: "[!] ",
  statusSuccess: "[ok] ",
};

export type StatusKind = "info" | "error" | "success";

export function statusPrefix(kind: StatusKind): string {
  switch (kind) {
    case "info":
      return THEME.statusInfo;
    case "error":
      return THEME.statusError;
    case "success":
      return THEME.statusSuccess;
  }
}

export function formatTitle(tab: string): string {
  return `${THEME.header}${tab}`;
}
