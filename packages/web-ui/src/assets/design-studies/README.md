# Service icon study

`service-icon-study.png` is the reference exploration for the non-mascot icon
language described in [`docs/cozy-dashboard-design.md`](../../../../../docs/cozy-dashboard-design.md).
It proposes a shared filled silhouette treatment for object storage,
network storage, local storage, protected folders, and synced folders.

It is not imported by the application. Draw the final icons as separate,
accessible SVG components that inherit `currentColor`; preserve the semantic
distinction rather than reproducing the image pixel-for-pixel. Do not place
these service icons in the `llamas/` family.
