import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandLockup } from "./BrandLockup.tsx";

describe("BrandLockup", () => {
  it("keeps the product name as live text beside a decorative mark", () => {
    const html = renderToStaticMarkup(<BrandLockup className="rail-brand" />);

    expect(html).toContain('class="brand-lockup rail-brand"');
    expect(html).toContain('class="brand-name"');
    expect(html).toContain("Lama");
    expect(html).toContain("Sync");
    expect(html).toContain('aria-hidden="true"');
    // LAMA-329: the approved courier identity replaced the earlier pack mark.
    // Both one-colour, theme-specific derivatives must be present so the mark
    // follows the resolved theme rather than only one of them.
    expect(html).toContain("lama-courier-dark-moss.png");
    expect(html).toContain("lama-courier-light-teal.png");
  });
});
