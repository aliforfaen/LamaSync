import { PWA_ICONS } from "../pwa-icons.generated.ts";

/**
 * LAMA-329 phase 7: the web app manifest.
 *
 * Served from `GET /manifest.webmanifest`. It lives at the root rather than
 * under `/api/v1` because `scope` and `start_url` are interpreted relative to
 * the document, and keeping the manifest and the service worker at the root is
 * what makes one installed app own the whole origin.
 *
 * `name`/`short_name` are the installed-app labels; both are the product name
 * because there is no room for a longer form on a home screen and "LamaSync" is
 * already short.
 */
export const PWA_MANIFEST_NAME = "LamaSync";

/**
 * Splash and toolbar colours for the installed app.
 *
 * A manifest carries ONE theme colour, so this is the dark canvas token from
 * `packages/web-ui/src/index.css` — the app's default appearance is dark and a
 * dark splash on a light phone is the less jarring of the two mistakes. The
 * running page overrides the toolbar colour per scheme with two media-scoped
 * `<meta name="theme-color">` tags in `index.html`; the manifest value is what
 * the launcher uses before the first paint.
 */
export const PWA_THEME_COLOR = "#121310";

/** The canvas token, so the splash matches the first frame the SPA paints. */
export const PWA_BACKGROUND_COLOR = "#121310";

export interface WebAppManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  categories: string[];
}

/**
 * Builds the manifest served at request time.
 *
 * `start_url` and `scope` are the origin root: the SPA is a single document
 * with hash routing, so every screen is the same URL and a narrower scope would
 * only break deep links (`/#/hosts`) that the installed app is expected to
 * resolve.
 */
export function webAppManifest(): WebAppManifest {
  return {
    id: "/",
    name: PWA_MANIFEST_NAME,
    short_name: PWA_MANIFEST_NAME,
    description:
      "Manage a personal sync fleet: folders, devices, backups and recovery.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    icons: PWA_ICONS.map((icon) => ({
      src: icon.path,
      sizes: icon.sizes,
      type: "image/png",
      purpose: icon.purpose,
    })),
    categories: ["utilities", "productivity"],
  };
}
