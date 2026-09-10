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
