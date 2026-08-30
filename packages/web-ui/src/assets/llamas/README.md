# Lama visual concepts

These are source illustrations for the visual direction documented in
[`docs/cozy-dashboard-design.md`](../../../../../docs/cozy-dashboard-design.md).
They are intentionally **not imported by the application yet**.

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
