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
    expect(html).toContain("lama-pack-dark-moss.png");
    expect(html).toContain("lama-pack-light-teal.png");
  });
});
