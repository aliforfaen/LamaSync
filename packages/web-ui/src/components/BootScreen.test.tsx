// LAMA-329 phase 6: the boot state renders the llama pose the plan named, and
// announces itself. The pose assertion is by markup equality with the pose
// itself, so swapping in another pose fails here rather than quietly changing
// the design.

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BootScreen } from "./BootScreen.tsx";
import { Llama } from "./Llama.tsx";

describe("BootScreen", () => {
  it("announces the boot state to assistive technology", () => {
    const html = renderToStaticMarkup(<BootScreen />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Checking session");
  });

  it("uses the nap pose, the slot LAMA-274 reserved for loading", () => {
    const html = renderToStaticMarkup(<BootScreen />);
    const nap = renderToStaticMarkup(<Llama className="boot-llama" pose="nap" size={56} />);
    expect(html).toContain(nap);
  });

  it("is decoration only: the llama is hidden from the accessibility tree", () => {
    const html = renderToStaticMarkup(<BootScreen />);
    // Every glyph in this family is aria-hidden, so the status text is what a
    // screen reader reads.
    expect(html).toContain('aria-hidden="true"');
  });
});
