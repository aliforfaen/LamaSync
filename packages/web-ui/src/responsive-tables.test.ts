// LAMA-334 item 6: no page may squeeze a desktop table onto a phone.
//
// The reported defect was a host's folder table collapsing text into vertical,
// character-per-line lines: seven columns, `table-layout: fixed` below 900px
// and `overflow-wrap: anywhere` is a precise recipe for that. The fix is the
// existing list skeleton (`.data-list` below 640px), and the failure mode is
// invisible in review — adding one more column to a table is an ordinary edit.
//
// So this reads the JSX that owns each table and holds the invariant: a
// `table.data` with more than four desktop columns must either collapse
// (`data-list`) or sit in a deliberate horizontal scroller. The exemptions are
// listed with the reason they exist, so removing one is a decision rather than
// an oversight.

import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

/** Files whose tables are exempt from the collapse rule, with the reason. */
const EXEMPT: Record<string, string> = {
  // Seven storage columns that the desktop table needs; the phone rule hides
  // columns 3–8 in `index.css` instead of restacking the row.
  "pages/Backends.tsx": "column-hiding rules for .data-backends",
  // The data browser's listing is a deliberate horizontal scroll pane
  // (`.browser-table-scroll`), not a squeezed grid: file names and paths are
  // the content and truncating them is worse than panning.
  "pages/DataBrowser.tsx": ".browser-table-scroll pane",
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/** Longest-match file key relative to `src/`, for the EXEMPT lookup. */
function relativeKey(file: string): string {
  return file.slice(SRC.length);
}

interface TableShape {
  file: string;
  classes: string;
  columns: number;
  inScrollPane: boolean;
}

/**
 * Classes that already carry a phone treatment. `data-list` is the generic
 * list skeleton; `data-folders` is the bespoke one the folders table has had
 * since LAMA-239 (grouped rows with an expanded per-host table).
 */
const COLLAPSING_CLASSES = new Set(["data-list", "data-folders"]);

function tablesIn(file: string): TableShape[] {
  const source = readFileSync(file, "utf8");
  const shapes: TableShape[] = [];
  const marker = /<table className="([^"]*)"/g;
  let match = marker.exec(source);
  while (match !== null) {
    const classes = match[1];
    if (classes.split(/\s+/).includes("data")) {
      // Bound the scan to THIS table: a table without a `<thead>` (a key/value
      // panel) must not borrow the next table's `<th>`s.
      const rest = source.slice(match.index);
      const endOfHead = rest.indexOf("</thead>");
      const endOfTable = rest.indexOf("</table>");
      const end = [endOfHead, endOfTable].filter((i) => i !== -1).sort((a, b) => a - b)[0] ?? -1;
      const segment = end === -1 ? "" : rest.slice(0, end);
      const columns = (segment.match(/<th[\s/>]/g) ?? []).length;
      // A deliberate scroll pane an ancestor provides, or the table's own
      // `browser-table` class.
      const before = source.slice(Math.max(0, match.index - 400), match.index);
      const inScrollPane =
        before.includes("browser-table-scroll") || classes.includes("browser-table");
      shapes.push({ file: relativeKey(file), classes, columns, inScrollPane });
    }
    match = marker.exec(source);
  }
  return shapes;
}

describe("responsive tables (LAMA-334 item 6)", () => {
  const shapes = sourceFiles(SRC).flatMap(tablesIn);

  it("finds the tables it is meant to police", () => {
    // A silent zero here would make the whole file vacuous.
    expect(shapes.length).toBeGreaterThan(10);
    expect(shapes.some((s) => s.classes.includes("data-list"))).toBe(true);
  });

  it("collapses or pans every table with more than four desktop columns", () => {
    const offenders = shapes
      .filter((s) => s.columns > 4)
      .filter((s) => !s.classes.split(/\s+/).some((c) => COLLAPSING_CLASSES.has(c)))
      .filter((s) => !s.inScrollPane)
      .filter((s) => !(s.file in EXEMPT))
      .map((s) => `${s.file}: ${s.columns} columns ("${s.classes}")`);

    expect(offenders).toEqual([]);
  });

  it("keeps every exemption tied to a file that still has a wide table", () => {
    // If a table stops being wide, its exemption must be deleted rather than
    // silently covering the next wide table someone adds to that file.
    for (const file of Object.keys(EXEMPT)) {
      const wide = shapes.filter((s) => s.file === file && s.columns > 4);
      expect(wide.length).toBeGreaterThan(0);
    }
  });

  it("gives every collapsed value that is not self-describing a label", () => {
    // The collapsed row drops the `<thead>`, so a bare timestamp or id would
    // arrive unlabelled. `data-label` puts the column name back.
    const hostDetail = readFileSync(join(SRC, "pages/HostDetail.tsx"), "utf8");
    expect(hostDetail).toContain('data-label="Time"');
    expect(hostDetail).toContain('data-label="Created"');
    expect(hostDetail).toContain('data-label="Schedule"');

    const accessKeys = readFileSync(join(SRC, "components/AccessKeysPanel.tsx"), "utf8");
    expect(accessKeys).toContain('data-label="Fingerprint"');
    expect(accessKeys).toContain('data-label="Last used"');
  });
});
