// LAMA-329 phase 5: the browser density preference.
//
// The plan lists "density" among the browser-only preferences, and the CSS
// token contract answers what it should mean: "comfortable sizes win over
// density except inside dense tables/logs". So this is a small, named step
// rather than a scale — `comfortable` is the default and is what the rest of
// the stylesheet encodes; `compact` only tightens the recurring surfaces (page
// gutters, section rhythm, table cells, device cards). Type sizes deliberately
// do not change: shrinking text is not what an operator reading a fleet should
// get from "denser".
//
// Like the theme, this is one value per browser profile and lives only in the
// SPA. It is mirrored onto `<html data-density>` so the stylesheet can branch
// without JS, and it is independent of the Android companion's settings.

export type DensityChoice = "comfortable" | "compact";

const DENSITY_KEY = "lamasync-density";
const VALID_CHOICES: DensityChoice[] = ["comfortable", "compact"];

export function loadDensityChoice(): DensityChoice {
  if (typeof localStorage === "undefined") {
    return "comfortable";
  }
  const stored = localStorage.getItem(DENSITY_KEY);
  if (stored && (VALID_CHOICES as readonly string[]).includes(stored)) {
    return stored as DensityChoice;
  }
  return "comfortable";
}

export function saveDensityChoice(choice: DensityChoice): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(DENSITY_KEY, choice);
  }
}

/** Mirror the choice onto `<html data-density>`; call at boot and on change. */
export function applyDensity(choice: DensityChoice): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.density = choice;
  }
}
