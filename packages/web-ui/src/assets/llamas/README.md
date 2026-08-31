# Lama visual concepts

These are source illustrations for the visual direction documented in
[`docs/cozy-dashboard-design.md`](../../../../../docs/cozy-dashboard-design.md).
Only the umbrella drift is currently imported by the application; the other
files remain supporting visual direction.

The umbrella drift is currently used as a subtle raster illustration in the
Dashboard empty-fleet state. The inline `Llama` SVG component remains the
compact, theme-aware alternative for product UI.

| Asset | Intended moment |
| --- | --- |
| `umbrella-loading-concept.png` | a quiet empty/loading state or subtle dashboard background |
| `slip-error-concept.png` | a recoverable error or failed-sync empty state |
| `filled-icon-pose-study.png` | visual reference for the compact filled llama icon family |

The two illustrations preserve transparency and are supporting artwork, not
everyday product chrome. The pose study is not a sprite sheet for production:
redraw selected poses as simple, filled, single-colour SVG components before
using them at 16–32px. Those SVGs should inherit `currentColor`, work in both
themes, and avoid the study's extra facial details.
