# Lama pack mark

## Courier mark (current product identity)

The full-body courier llama is the current LamaSync application identity. It
stands front-on with balanced storage panniers and a sync medallion, tying the
mascot directly to LamaSync's purpose.

| Asset | Use |
| --- | --- |
| `lama-courier-color.png` | Source artwork, Android launcher exports, and large brand moments |
| `lama-courier-dark-moss.png` | One-color `#9ABB70` header mark on dark UI |
| `lama-courier-light-teal.png` | One-color `#176F68` header mark on light UI |

The one-color files are mechanically derived from the approved source alpha,
so their geometry is identical. The shared `BrandLockup` uses these variants;
the product name remains live HTML text. Keep the full figure at least 28px
tall in product chrome and preserve the transparent padding around the packs.

The older field-pack assets below remain available as historical/supporting
brand artwork, but are no longer the web-header identity.

This is the primary LamaSync brand mark: a calm, forward-moving llama carrying
a small field pack. It is intentionally more detailed than the compact llama
icons, but still reads as a single-colour silhouette.

| Asset | Colour | Use it on |
| --- | --- | --- |
| `lama-pack-black.png` | `#171710` | light backgrounds, print, or neutral documentation |
| `lama-pack-white.png` | `#ffffff` | dark surfaces only |
| `lama-pack-dark-moss.png` | `#9abb70` | LamaSync's dark interface (`--accent-ok`) |
| `lama-pack-light-teal.png` | `#176f68` | LamaSync's light interface (`--accent-info`) |

All four PNGs have transparent backgrounds and the same 1448×1086 canvas.
The web navigation uses `lama-pack-dark-moss.png` on the dark theme and
`lama-pack-light-teal.png` on the light theme through the shared
`components/BrandLockup.tsx` component. The `LamaSync` title is deliberately
live HTML text beside the decorative image; do not bake the wordmark into a
new raster export.

Use the mark for a page masthead, onboarding, release material, and future app
identity where it is at least 48px tall. Keep clear space around the ears,
pack, and feet; the source canvas already includes transparent breathing room.
Do not place it inside a generic rounded-square badge or recolour just part of
the mark.

For future favicons, PWA icons, desktop icons, or mobile app icons, derive
purpose-built square exports from the original mark while preserving the
silhouette and its clear space. Validate each export at its target size on
both light and dark backgrounds; do not use these 4:3 presentation PNGs
directly as tiny icons, and do not use the mark as a semantic 16–32px UI icon.

When the mark appears without the live `LamaSync` title, give the image a
meaningful accessible name. When it appears beside the title, keep the image
decorative (`alt=""`, `aria-hidden="true"`) as the shared component does.

This is a finished raster brand asset, not the 16–32px product icon family.
At those small sizes, use the simple hand-authored SVG silhouettes described
in `docs/cozy-dashboard-design.md` instead.

## Installable-app exports (LAMA-329 phases 6–7)

`../pwa/` holds the icon set the web app manifest advertises. These are inputs
to `scripts/gen-pwa-assets.ts`, which embeds them as base64 in the server so the
compiled binary can serve them without a runtime asset directory.

| File | Manifest entry | Derivation |
| --- | --- | --- |
| `pwa/icon-192.png` | `192x192`, `purpose: any` | `lama-courier-color.png` resized, palette-quantised to 256 colours |
| `pwa/icon-512.png` | `512x512`, `purpose: any` | same |
| `pwa/icon-maskable-512.png` | `512x512`, `purpose: maskable` | mark at 410px centred on `#14302B` |

The maskable export is padded on purpose: Android masks installed icons to a
circle/squircle, and the mark must sit inside the centre 80% of the canvas.
Measured after generating: the mark's furthest pixel is 185px from centre, i.e.
72% of the half-canvas, inside the limit. The `any` icons are not padded to that
rule — they are what Chrome shows in the install dialog and app list — so if a
launcher ever masks one, re-generate them smaller rather than assuming.

### Regenerating

This is a one-off art step and needs ImageMagick and Pillow; neither is a build
dependency, because the outputs are committed.

```bash
# PWA icons (from packages/web-ui/src/assets/brand)
magick lama-courier-color.png -resize 512x512 -colors 256 -strip \
  -define png:compression-level=9 ../pwa/icon-512.png
magick lama-courier-color.png -resize 192x192 -colors 256 -strip \
  -define png:compression-level=9 ../pwa/icon-192.png
magick lama-courier-color.png -resize 410x410 -background "#14302B" \
  -gravity center -extent 512x512 -strip \
  -define png:compression-level=9 ../pwa/icon-maskable-512.png
```

The Android notification glyph and the adaptive-icon monochrome layer are
derived from `drawable-*dpi/lama_courier_launcher.png` in the Android resource
tree: take the alpha channel and fill it white, keeping the mark on the same
108dp canvas for the monochrome layer so it aligns with the foreground, and
cropping to the mark's bounding box for the 24dp notification icon so the figure
fills the status-bar target. Verify the results the way this pass did: render the
notification at true 24px and magnify it, rather than judging a large version.

One trap worth recording: the art's alpha is already a solid silhouette (the
body is opaque; transparent regions all connect to the outside), so "fill the
holes" does nothing measurable. If a hole-filling step reports zero pixels
added, the condition is inverted — check the count, not the picture.
