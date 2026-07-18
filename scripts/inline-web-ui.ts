#!/usr/bin/env bun
/**
 * Post-build inline step for the web-ui package.
 *
 * Reads packages/web-ui/dist/index.html and packages/web-ui/dist/assets/*,
 * replaces each `<script src=...>` and `<link href=...>` tag in <head>
 * with an inline `<script type="module">` / `<style>` block, and deletes
 * the assets/ directory so the artifact is a single self-contained file.
 *
 * Invoked by the package.json `build` script after `vite build` finishes.
 *
 * Implementation note: we deliberately use `indexOf` + `slice` + concat
 * rather than `String.prototype.replace` because Bun's replace path with
 * very large replacement strings (~180 KB) and a multi-byte UTF-8 source
 * produces unexpected extra content.
 */
import { readdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const DIST = join(ROOT, "packages/web-ui/dist");
const HTML_PATH = join(DIST, "index.html");
const ASSETS_DIR = join(DIST, "assets");

const assetNames = await readdir(ASSETS_DIR).catch(() => [] as string[]);
const html = await readFile(HTML_PATH, "utf8");
if (!html.includes("</head>")) {
  throw new Error("[inline-web-ui] no </head>");
}

let bundledHtml = html;

for (const name of assetNames) {
  const data = await readFile(join(ASSETS_DIR, name));
  const ext = name.split(".").pop() ?? "";
  const url = `/assets/${name}`;

  if (ext === "css") {
    const link = `<link rel="stylesheet" crossorigin href="${url}">`;
    const idx = bundledHtml.indexOf(link);
    if (idx < 0) throw new Error(`[inline-web-ui] missing ${url} tag`);
    const text = data.toString("utf8");
    bundledHtml =
      bundledHtml.slice(0, idx) + `<style>${text}</style>` + bundledHtml.slice(idx + link.length);
  } else if (ext === "js") {
    const scriptOpen = `<script type="module" crossorigin src="${url}"></script>`;
    const idx = bundledHtml.indexOf(scriptOpen);
    if (idx < 0) throw new Error(`[inline-web-ui] missing ${url} tag`);
    // Escape literal `</script>` substrings inside the JS body so the HTML
    // parser doesn't terminate the outer inline `<script type="module">` at
    // the first inner `</script>`.
    const text = data.toString("utf8").split("</script>").join("<\\/script>");
    bundledHtml =
      bundledHtml.slice(0, idx) +
      `<script type="module">\n${text}\n</script>` +
      bundledHtml.slice(idx + scriptOpen.length);
  }
}

await writeFile(HTML_PATH, bundledHtml, "utf8");
await rm(ASSETS_DIR, { recursive: true, force: true });
console.log(
  `[inline-web-ui] inlined ${assetNames.length} asset(s) into ${HTML_PATH}`,
);
