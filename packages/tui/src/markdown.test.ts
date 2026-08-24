import { describe, expect, it } from "bun:test";
import {
  extractFoldSections,
  formatMarkdownTables,
  formatMarkdownText,
  renderFoldSectionLines,
  renderMarkdownTableBlock,
} from "./markdown.ts";

const TABLE = [
  "| Name | Kind | Endpoint |",
  "|------|------|----------|",
  "| Exoscale | s3 | sos-zone.exo.io |",
].join("\n");

// Expected column width for the table at 80 cols: floor((80-1)/3) - 3 = 23.
const W80 = 23;
function row80(cells: string[]): string {
  return `| ${cells.map((c) => c.padEnd(W80)).join(" | ")} |`;
}

describe("renderMarkdownTableBlock", () => {
  it("renders an aligned fixed-width table (golden, 80 cols)", () => {
    expect(renderMarkdownTableBlock(TABLE, 80)).toEqual([
      row80(["Name", "Kind", "Endpoint"]),
      row80(["Exoscale", "s3", "sos-zone.exo.io"]),
    ]);
  });

  it("every row fits the requested width and stays pipe-delimited", () => {
    const rows = renderMarkdownTableBlock(TABLE, 40);
    for (const r of rows) {
      expect(r.length).toBeLessThanOrEqual(40);
      expect(r.startsWith("| ")).toBe(true);
      expect(r.endsWith(" |")).toBe(true);
    }
  });

  it("truncates over-long cells with an ellipsis", () => {
    const long = [
      "| name |",
      "|------|",
      "| sos-zone.exo.io-very-long-bucket-name |",
    ].join("\n");
    const rows = renderMarkdownTableBlock(long, 40);
    // 1 col at 40 → colWidth = floor((40-1)/1) - 3 = 36.
    expect(rows[1]).toBe(`| sos-zone.exo.io-very-long-bucket-na… |`);
    expect(rows[1]!.length).toBe(40);
    expect(rows[1]!.endsWith("… |")).toBe(true);
  });
});

describe("formatMarkdownTables", () => {
  it("reformats table blocks in place and preserves surrounding prose", () => {
    const input = ["Devices", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "End"].join("\n");
    const width = 40; // 2 cols → colWidth = floor((40-1)/2) - 3 = 16
    const expected = [
      "Devices",
      "",
      `| ${"a".padEnd(16)} | ${"b".padEnd(16)} |`,
      `| ${"1".padEnd(16)} | ${"2".padEnd(16)} |`,
      "",
      "End",
    ].join("\n");
    expect(formatMarkdownTables(input, width)).toBe(expected);
  });

  it("is a no-op on plain text", () => {
    const plain = "Global keys\n?      toggle help\nq      quit";
    expect(formatMarkdownTables(plain, 80)).toBe(plain);
  });
});

describe("extractFoldSections", () => {
  it("pulls summary + body out of a <details> block", () => {
    const md = "Intro\n\n<details><summary>Devices</summary>See docs/terminology.md for the glossary.</details>\n\nOutro";
    expect(extractFoldSections(md)).toEqual([
      { summary: "Devices", body: "See docs/terminology.md for the glossary." },
    ]);
  });

  it("returns [] when there are no <details> blocks", () => {
    expect(extractFoldSections("just text")).toEqual([]);
  });
});

describe("renderFoldSectionLines", () => {
  const md = "Intro\n\n<details><summary>Devices</summary>See docs/terminology.md for the glossary.</details>\n\nOutro";

  it("renders collapsed folds as [+] rows (golden)", () => {
    expect(renderFoldSectionLines(md, 80)).toBe(
      "Intro\n\nOutro\n[+] Devices",
    );
  });

  it("renders open folds as [-] rows with an indented body (golden)", () => {
    expect(renderFoldSectionLines(md, 80, new Set([0]))).toBe(
      "Intro\n\nOutro\n[-] Devices\n    See docs/terminology.md for the glossary.",
    );
  });

  it("truncates long lines to the width", () => {
    const long = "<details><summary>X</summary>" + "y".repeat(200) + "</details>";
    const out = renderFoldSectionLines(long, 40);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

describe("formatMarkdownText", () => {
  it("combines fold rendering and table alignment", () => {
    const md = [
      "Intro",
      "",
      "<details><summary>Devices</summary>",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "</details>",
      "",
      "End",
    ].join("\n");
    // Collapsed: details removed (its blank-line run collapses), then no
    // table remains at the top level, so the body passes through.
    expect(formatMarkdownText(md, 80)).toBe("Intro\n\nEnd\n[+] Devices");
  });
});
