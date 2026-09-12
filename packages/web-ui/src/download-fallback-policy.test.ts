// LAMA-335 review finding 1: Preview and Download share ONE byte transport
// (`POST /api/v1/browse/download`, 64 MiB server cap). The plan module now
// reports `downloadable: false` above that cap; this guard holds the page half
// of the decision — the row must consume the plan and must not render a
// Download button for a file the transport will reject.
//
// A static scan is the right shape here, matching `responsive-tables.test.ts`
// and `browse-trust-boundary.test.ts`: the failure mode is an edit to the JSX
// that silently restores the dead-end button, not a runtime branch.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

function source(path: string): string {
  return readFileSync(join(SRC, path), "utf8");
}

describe("download fallback policy (LAMA-335 finding 1)", () => {
  const browser = source("pages/DataBrowser.tsx");

  it("drives the row actions from the single preview plan", () => {
    // The plan is computed once per file row and both actions read it.
    expect(browser).toContain("previewPlanFor(entry.name, entry.size)");
    expect(browser).toContain("plan.downloadable");
  });

  it("states the limit instead of offering a download the transport refuses", () => {
    expect(browser).toContain("browser-download-blocked");
    expect(browser).toContain("Too large to download");
  });

  it("never renders a Download button without reading the plan", () => {
    // The old code was `onDownload && entry.type === "file" && (<button …>`.
    // Finding it again means the transport gate is gone.
    expect(browser).not.toMatch(/onDownload\s*&&\s*entry\.type === "file"\s*&&\s*\(\s*<button/);
  });
});
