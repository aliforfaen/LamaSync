// Markdown rendering helpers for the TUI (LAMA-153).
//
// OpenTUI's MarkdownRenderable already renders markdown tables natively in
// rich contexts (dotfiles preview). The surfaces that print plain text —
// the adaptive help overlay and view instruction lines — get aligned,
// fixed-width tables here, plus `<details>`-style sections rendered as
// expandable "[+]"/"[-]" rows (the `open` set drives expansion; a focused
// widget owns Enter, per LAMA-173 — this module only produces the lines).
//
// Everything is pure and width-aware (respects the 80-col constraint).

export interface FoldSection {
  summary: string;
  body: string;
}

/** Split one markdown table row (`| a | b |`) into trimmed cells. */
function parseTableRow(line: string): string[] {
  const parts = line.split("|");
  if (parts.length > 0 && (parts[0]?.trim() ?? "") === "") parts.shift();
  if (parts.length > 0 && (parts[parts.length - 1]?.trim() ?? "") === "") parts.pop();
  return parts.map((p) => p.trim());
}

function isSeparatorRow(line: string | undefined): boolean {
  if (!line) return false;
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Render a markdown table block (header + separator + body rows) as aligned
 * fixed-width text rows. Columns are sized to fit `width`; over-long cells
 * are truncated with an ellipsis. Returns one string per rendered row.
 */
export function renderMarkdownTableBlock(block: string, width: number): string[] {
  const rawRows = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (rawRows.length === 0) return [];
  const rows = rawRows.map(parseTableRow);
  // Drop the separator row (`|---|---|`) if present (position 1).
  const body = rows.filter((r, i) => !(i === 1 && r.every((c) => /^:?-{2,}:?$/.test(c))));
  const ncols = Math.max(1, ...body.map((r) => r.length));
  const padded = body.map((r) =>
    Array.from({ length: ncols }, (_, i) => r[i]?.trim() ?? ""),
  );
  // `| ` + cell + (ncols-1)×` | ` + ` |` must fit in `width`.
  const colWidth = Math.max(4, Math.floor((width - 1) / ncols) - 3);
  return padded.map(
    (r) =>
      `| ${r.map((c) => truncate(c, colWidth).padEnd(colWidth)).join(" | ")} |`,
  );
}

/**
 * Reformat any markdown table blocks found in `text`; everything else passes
 * through untouched. Safe to run over plain text (no-op when no tables).
 */
export function formatMarkdownTables(text: string, width: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().startsWith("|") && isSeparatorRow(lines[i + 1])) {
      const block: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
        block.push(lines[i] ?? "");
        i += 1;
      }
      out.push(...renderMarkdownTableBlock(block.join("\n"), width));
    } else {
      out.push(line);
      i += 1;
    }
  }
  return out.join("\n");
}

/** Extract `<details>` sections as {summary, body} entries. */
export function extractFoldSections(text: string): FoldSection[] {
  const out: FoldSection[] = [];
  const re = /<details>([\s\S]*?)<\/details>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1] ?? "";
    const sm = /<summary>([\s\S]*?)<\/summary>/i.exec(inner);
    const summary = (sm?.[1] ?? "").trim();
    const body = inner.replace(/<summary>[\s\S]*?<\/summary>/i, "").trim();
    out.push({ summary, body });
  }
  return out;
}

function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, "\n\n");
}

function truncateLine(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s;
  return `${s.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * Render `<details>` sections as fold rows: `[+] summary` when collapsed,
 * `[-] summary` + indented body when open (indexes in `open`). The
 * surrounding text keeps its position; blank-line runs collapse to one.
 */
export function renderFoldSectionLines(
  text: string,
  width: number,
  open: ReadonlySet<number> = new Set(),
): string {
  const sections = extractFoldSections(text);
  if (sections.length === 0) return text;
  const bodyText = collapseBlankLines(
    text.replace(/<details>[\s\S]*?<\/details>/gi, "").trim(),
  );
  const lines: string[] = [];
  if (bodyText.length > 0) lines.push(bodyText);
  sections.forEach((s, i) => {
    lines.push(`${open.has(i) ? "[-]" : "[+]"} ${s.summary || "(section)"}`);
    if (open.has(i)) {
      for (const l of s.body.split(/\r?\n/)) lines.push(`    ${l}`);
    }
  });
  return lines.map((l) => truncateLine(l, width)).join("\n");
}

/**
 * One-stop formatting for plain-text markdown-ish content: folds first
 * (so bodies can still contain tables), then table alignment.
 */
export function formatMarkdownText(
  text: string,
  width: number,
  open: ReadonlySet<number> = new Set(),
): string {
  return formatMarkdownTables(renderFoldSectionLines(text, width, open), width);
}
