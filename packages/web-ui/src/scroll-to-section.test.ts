// LAMA-345 follow-up — in-page section navigation.
//
// Regression this guards: the Dashboard's urgent row was a router Link to
// `/#fleet-health-heading`. Under HashRouter that resolves to
// `/#/#fleet-health-heading`, the route changes instead of scrolling, and the
// Fleet health heading stays off-screen. The fix is a real button that scrolls
// and focuses the section, so it must not regress back into a link.

import { describe, expect, test } from "bun:test";
import {
  focusAndScroll,
  scrollFocusOptions,
  scrollToSection,
  type ScrollFocusTarget,
} from "./scroll-to-section.ts";

interface Recorded {
  scrolls: ScrollIntoViewOptions[];
  focuses: FocusOptions[];
}

/** A structural stub — no casts, no DOM. */
function stubTarget(record: Recorded): ScrollFocusTarget {
  return {
    scrollIntoView(options?: ScrollIntoViewOptions) {
      record.scrolls.push(options ?? {});
    },
    focus(options?: FocusOptions) {
      record.focuses.push(options ?? {});
    },
  };
}

function record(): Recorded {
  return { scrolls: [], focuses: [] };
}

describe("scrollFocusOptions", () => {
  test("smooth when motion is allowed, instant when it is reduced", () => {
    expect(scrollFocusOptions(false)).toEqual({ behavior: "smooth", block: "start" });
    expect(scrollFocusOptions(true)).toEqual({ behavior: "auto", block: "start" });
  });
});

describe("focusAndScroll", () => {
  test("scrolls to the start of the section and focuses it without re-scrolling", () => {
    const seen = record();
    focusAndScroll(stubTarget(seen), false);
    expect(seen.scrolls).toEqual([{ behavior: "smooth", block: "start" }]);
    // `preventScroll` keeps the focus call from fighting the scroll we asked for.
    expect(seen.focuses).toEqual([{ preventScroll: true }]);
  });

  test("honours the reduced-motion answer", () => {
    const seen = record();
    focusAndScroll(stubTarget(seen), true);
    expect(seen.scrolls[0]?.behavior).toBe("auto");
    // Focus still moves — skipping motion must not skip the destination.
    expect(seen.focuses).toHaveLength(1);
  });
});

describe("scrollToSection", () => {
  test("a missing section is reported instead of silently doing nothing", () => {
    expect(scrollToSection("nope", () => null, () => false)).toBe(false);
  });

  test("resolves the section by id and focuses it", () => {
    const seen = record();
    const target = stubTarget(seen);
    const asked: string[] = [];
    const ok = scrollToSection(
      "fleet-health",
      (id) => {
        asked.push(id);
        return id === "fleet-health" ? target : null;
      },
      () => false,
    );
    expect(ok).toBe(true);
    expect(asked).toEqual(["fleet-health"]);
    expect(seen.scrolls).toHaveLength(1);
    expect(seen.focuses).toHaveLength(1);
  });

  test("reads the reduced-motion preference at call time, not import time", () => {
    const seen = record();
    let reduce = false;
    scrollToSection("fleet-health", () => stubTarget(seen), () => reduce);
    reduce = true;
    scrollToSection("fleet-health", () => stubTarget(seen), () => reduce);
    expect(seen.scrolls.map((s) => s.behavior)).toEqual(["smooth", "auto"]);
  });
});
