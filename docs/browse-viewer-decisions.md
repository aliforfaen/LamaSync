# Backup viewer: component decision and the shipped slice (LAMA-335)

Status: decided and implemented. This records **what** the viewer is made of,
**why** each alternative was rejected, and the trust boundary the choice keeps.

Date: 2026-09-11. Issue: LAMA-335.

## What the issue asked for

Turn backup viewing into in-app browsing/preview of shared S3-compatible
folders: authorized folder listing/navigation, normalized paths, metadata, safe
preview of an agreed initial file set with a clear fallback, no storage
credentials or reusable backend grants in the WebView, authorization defended
on every action, and a recorded component decision "rather than reinventing a
complete file manager".

## What already existed (so this is an extension, not a rewrite)

Verified in the tree before choosing anything:

| Layer | What was already there |
| --- | --- |
| Server routes | `packages/server/src/routes/browse.ts`: `GET /browse/local`, `GET /browse/s3`, `GET /browse/restic`, `GET /browse/jobs`, `POST /browse/{copy,move,delete,rename,mkdir,upload,size,download}`. All under `/api/v1`, all with Swagger detail. |
| Path safety | `packages/server/src/browse-paths.ts`: `validateBrowseInput` and `isValidS3Path` reject NUL bytes, absolute paths, `..` segments, empty segments and control characters; `resolveBrowsePath` joins and symlink-resolves, rejecting escapes. |
| Storage access | `packages/server/src/s3-list.ts` signs ListObjectsV2 with the project's **own** SigV4 implementation. There is no S3 SDK, no presigned URL and no client-side storage credential anywhere. |
| Bytes to the client | `POST /browse/download` returns `{ name, content: <base64> }`, capped at 64 MiB. The server proxies; nothing reusable leaves it. |
| Listing UI | `packages/web-ui/src/pages/DataBrowser.tsx`: local / S3 / restic tabs, breadcrumbs, an entries table with name, type, size, modified, owner and row actions. |
| Preview | `packages/web-ui/src/file-preview.ts` (LAMA-260) classified **image** and **text** with a 256 KB text cap and magic-byte sniffing, and `FilePreviewModal` rendered them. |

So the work was: extend the preview set, make the listing legible at phone
width, prove the trust boundary, and record the decision.

## Candidates assessed

Sizes and licences below were checked against the registries at decision time
(sources at the end); "maintenance" is the last-release / activity signal that
was visible then.

### File browsing / listing

| Candidate | Licence | Weight | Verdict |
| --- | --- | --- | --- |
| **Existing hand-rolled `EntriesTable` + `.data-list` skeleton** | in-repo | 0 (already shipped, already tested) | **SELECTED** |
| `@tanstack/react-virtual` | MIT | ~24 KB min / 7.2 KB gzip | Rejected *for now*: the server caps a listing at 1000 keys, which the DOM handles; virtualisation is a performance answer to a problem this product does not have. It is the first pick if a page cap ever grows. |
| `@tanstack/react-table` | MIT | headless, small | Rejected: the table is already sorted dirs-then-files and has no column model to manage. |
| `react-aria` `Table`/`Grid` | MIT / Apache-2.0 per package | ~8–15 KB per component | Rejected: gold-standard a11y, but the a11y that matters here (breadcrumbs, a table with a header row, row actions, a focus-trapped modal) is already implemented and tested in-repo. |
| `react-window` | MIT | ~6 KB | Rejected: no meaningful releases for years — an unmaintained dependency in a credential-bearing page is a liability, not a saving. |
| `react-virtuoso` | MIT | ~10 KB | Rejected: variable-height chat scrollback is not the problem; a directory listing is. |
| `Chonky` | MIT | — | Rejected: **last release v2.3.2, January 2022**; unmaintained. |
| `@cubone/react-file-manager` | MIT | 449 KB unpacked, 4 deps | Rejected: it is a complete file manager (its own toolbar, upload, copy/move, breadcrumb). Adopting it means deleting the browse-ops plumbing and permissions the server already enforces in order to match its assumptions. |
| `filestash` | AGPL-3.0 | — | Rejected on licence: this repository is MIT (README `## License`). |
| `glide-data-grid` | MPL-2.0 + commercial gating | — | Rejected: spreadsheet-class rendering we do not need, plus a licence with a revenue clause. |
| MUI X Data Grid Community / AG Grid Community | MIT (community tiers) | large CSS/JS payloads | Rejected: the SPA is inlined into one `index.html` by `scripts/inline-web-ui.ts`; a grid's stylesheet and column model would be the largest thing in the app, for a table with six columns. |

### Preview

| Candidate | Licence | Weight | Verdict |
| --- | --- | --- | --- |
| **Browser-native rendering** (`<img>`, `<audio controls>`, `<video controls>`, `<pre>`) | none | 0 | **SELECTED** |
| `pdfjs-dist` (pdf.js) | Apache-2.0 | `pdf.min.js` ≈190 KB + `pdf.worker.min.js` ≈623 KB | Rejected for this slice: roughly doubles the inlined bundle for one format, and the 64 MiB base64 download path is a poor fit for large PDFs. Recorded as the next candidate if PDF is asked for. |
| `react-pdf` | MIT | pulls `pdfjs-dist` | Rejected with it. |
| `<embed>`/`<object>` for PDF | none | 0 | Rejected: unreliable in Android WebView (some versions hand off to a system viewer or download). |
| `highlight.js` | BSD-3-Clause | core + common languages ≈50–80 KB | Rejected for this slice: syntax colouring is decoration on a preview that already renders the text; it is the natural first addition if the operator asks. |
| `shiki` | MIT | ≈150–300 KB with grammars | Rejected on weight for the same reason. |
| `prismjs` | MIT | small core | Rejected: comparable to highlight.js and needs the same XSS care. |
| `react-syntax-highlighter` | MIT | large | Rejected: its default path renders HTML strings; the low-level token APIs of the alternatives are safer. |
| `CodeMirror 6` | MIT | editor-sized | Rejected: it is an editor, and preview is read-only. |

## What shipped

1. **The agreed initial preview set is image, text, audio and video**, all
   rendered by the browser itself. `previewPlanFor(name, size)` is the single
   decision point and returns a `kind`, a `sniff` flag and — when there is no
   viewer — a **reason sentence**, so "unsupported" is a stated outcome with a
   Download action beside it rather than a dead end.
2. **Limits are explicit**: text 256 KB (unchanged), audio/video 48 MB, images
   uncapped. The media cap exists because the whole payload arrives as base64
   JSON before becoming a Blob; above it the file is offered for download
   instead of being decoded on a phone.
3. **The preview Blob carries a MIME type** derived from the extension
   (`mimeTypeForName`). The browse-download response has no content type, and a
   typeless Blob is what makes `<audio>`/`<video>` refuse to play — the fix is
   one line and it is what the screenshots show working.
4. **Text is always rendered as text.** The preview module never builds HTML and
   `browse-trust-boundary.test.ts` fails if `innerHTML` or
   `dangerouslySetInnerHTML` ever appears in it.
5. **The listing is legible at phone width.** Below 640px the data browser's
   table becomes stacked rows (name + selection, type, labelled size and
   modified, then the row actions) instead of a 40rem-wide pan; at 640px and up
   the existing deliberate horizontal scroll pane is unchanged.
   `responsive-tables.test.ts` now covers this table like every other one.
6. **The trust boundary is tested on both sides.** Server:
   `packages/server/src/device-boundary.test.ts` asserts a device credential
   gets 403 on every browse action, that the same routes are 401 without one,
   and that an admin's S3 listing contains neither the destination's secret nor
   its access key nor a signed URL. Client:
   `packages/web-ui/src/browse-trust-boundary.test.ts` fails if an S3 client, a
   signed-URL helper or a credential field is ever added to the SPA, and if the
   viewer stops reading bytes through the authorized helpers.

Evidence: `docs/android-mobile-ux-artifacts/lama335-browser-360.png` (stacked
phone listing), `lama335-browser-1280.png` (the desktop table, unchanged),
`lama335-preview-{text,image,audio,video}-360.png` (each renderer in the modal,
with the audio player reporting the real duration and the video showing a
decoded frame).

## Deliberately not in this slice

- **PDF, syntax highlighting, virtualised long listings** — each is one
  dependency and a bundle decision, recorded above with its licence and weight
  so the next pass can pick one without re-researching.
- **Range requests / streaming.** `POST /browse/download` is a whole-file
  base64 response. Video preview works for files under the cap because the
  browser buffers the Blob; larger media wants a `Range`-aware download route,
  which is a server contract change and therefore its own decision.
- **Writes from the viewer.** The existing copy/move/rename/delete/upload
  actions and their authorization are untouched.

## Sources

- Repo: `packages/server/src/routes/browse.ts`, `browse-paths.ts`,
  `s3-list.ts`, `packages/web-ui/src/file-preview.ts`,
  `pages/DataBrowser.tsx`, `scripts/inline-web-ui.ts`, `README.md`.
- `@tanstack/react-virtual` — npm registry (MIT; v3.14.x) and Bundlephobia
  (~24 KB min / 7.2 KB gzip): <https://www.npmjs.com/package/@tanstack/react-virtual>,
  <https://bundlephobia.com/package/@tanstack/react-virtual>.
- `chonky` — npm registry (v2.3.2, published ~4 years ago):
  <https://www.npmjs.com/package/chonky>.
- `@cubone/react-file-manager` — npm registry (MIT, 1.35.0, 449 KB unpacked):
  <https://www.npmjs.com/package/@cubone/react-file-manager>.
- `pdfjs-dist` — npm registry (Apache-2.0; `pdf.min.js` 190 KB,
  `pdf.worker.min.js` 623 KB): <https://www.npmjs.com/package/pdfjs-dist>.
- Android's own guidance that a WebView bridge is the low-security option, which
  is part of why the viewer keeps the storage boundary on the server:
  <https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges>.
