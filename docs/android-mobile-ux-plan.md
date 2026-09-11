# LamaSync Android + mobile web UX plan

Status: phases 1–2 implemented; phases 3–8 (mobile web navigation, responsive
pass, browser `/settings`, brand/motion assets, PWA, screenshot evidence) remain
to implement.
Date: 2026-09-10

## Implementation status (updated on completion of phases 1–7)

Shipped, in the `android-stage-2` worktree:

- **Phase 1 — foundations.** `enableEdgeToEdge()`; backgrounds extend behind the
  system bars while every target and row stays inside `WindowInsets.safeDrawing`;
  a light/dark Material 3 scheme derived token-for-token from
  `packages/web-ui/src/index.css` (see `ui/theme/Palette.kt`, guarded by
  `PaletteMirrorsWebTokensTest`); Material You colouring as an explicit opt-in,
  off by default; the window background follows the *resolved* theme. The
  text-button strip became a Material 3 top app bar with the host, a
  connection-state dot **and label**, reload, a live reconnect action and the
  overflow menu. Android back walks WebView history first, then unwinds the
  back stack, with predictive back enabled via
  `android:enableOnBackInvokedCallback`.
- **Phase 1 — display-mode signal.** The companion appends
  `?lamasyncShell=android` to the initial document URL
  (`web/WebShellSignal.kt`); `packages/web-ui/src/shell.ts` consumes it once
  into `sessionStorage` and mirrors it onto `<html data-shell>`. It is
  presentation-only and is never read by an authorization path.
- **Phase 2 — native information architecture.** `androidx.navigation` owns
  Manage, Uploads, Camera protection, Settings, Connection and About with a real
  back stack. The enrollment flow keeps its existing `SessionViewModel` state
  machine on purpose: its resume-from-EXCHANGED and unconfirmed-cleanup
  invariants are load-bearing and are not re-expressed as navigation.
- **Phase 2 — Settings.** Appearance, Transfers, Camera protection,
  Notifications, Browser experience, Connection, About and the destructive
  disconnect. Every switch writes through the store that already owned that
  fact.
- Pull-to-refresh, which the plan listed under the native shell, is implemented
  with `SwipeRefreshLayout.setOnChildScrollUpCallback` — Compose's
  `Modifier.pullToRefresh` is nested-scroll driven and an `AndroidView` host
  dispatches no nested scroll, so it cannot express the "never fire while the
  page is scrolled away from top" gate around a WebView.
- **Phase 3 — mobile web navigation.** The rail below 900px is now two permanent
  surfaces instead of one off-canvas drawer: a **compact rail** from 640px up
  (`--nav-rail-compact-width`, same 12 destinations, smaller type) and a
  **bottom tab bar with a More sheet** below that. Four destinations stay in the
  bar — Dashboard, Devices, Managed folders, Backups — which is the fleet's
  day-to-day loop; Conflicts, storage destinations, recovery browsing, apps,
  Activity and Admin are one tap further in. Both sets are derived from
  `GROUPS` via a `quick` flag, so the phone and the rail cannot drift, and the
  sheet also carries the shell actions (API docs, theme cycle, sign out) that
  the hidden rail footer would otherwise have held. `ShellActions` is shared by
  both surfaces so the LAMA-296 server-side sign-out cannot be got wrong twice.
- **Phase 3 — safe areas.** The viewport opts into the display cutout
  (`viewport-fit=cover`) and the shell pads itself with `env(safe-area-inset-*)`
  exposed as `--safe-*` tokens; `min-height` subtracts the top inset so a
  notched device does not gain a phantom scroll. In the Android companion these
  resolve to 0, because the WebView already sits inside the native
  `safeDrawing` padding, so there is no double padding.
- **Phase 4 — responsive page pass.** Measured at 360 CSS px against the seeded
  demo fleet before the pass: `/apps/backups` rendered 670px of content,
  `/operations` 577px and `/admin` 632px inside a 360px viewport. Every route
  now measures `scrollWidth == viewport` at 360, 412, 600, 768 and 1280px, and
  no interactive control on a phone is under 48px tall. The multi-column tables
  collapse to list rows following the `.data-folders` precedent that already
  shipped; each keeps its identity, its decisive state and its actions, and
  drops the columns that the sentence, the expanded row or the detail view
  still carries. Evidence in `docs/android-mobile-ux-artifacts/`:
  `mobile-more-sheet-360.png`, `mobile-activity-360.png`,
  `tablet-compact-rail-768.png`, `desktop-rail-1280.png`.

How those numbers were produced, so the next phase can repeat it instead of
re-arguing it: run the server against a seeded demo fleet
(`POST /api/v1/demo/seed`) and the built `dist/index.html`, then for each route
set `location.hash` and read `document.documentElement.scrollWidth` against
`clientWidth`, flagging any element whose `getBoundingClientRect().right`
exceeds the viewport **and** has no clipping or scrolling ancestor. Two false
positives are worth knowing about, because both look like failures and are not:
a closed `<details>` keeps laying out its panel (Chrome hides it with
`content-visibility` on an internal slot, so the panel reports a real width)
and an `overflow: hidden` ancestor silently clips deliberate ellipsis. Measure
the built bundle rather than the dev server: while these edits were landing,
Vite's HMR left a stale module graph, which produced both a false clean
audit and a blank page.

- **Phase 5 — browser settings.** `#/settings`, registered in `GROUPS` under
  System so it is one tap from the More sheet and covered by the nav partition
  and route-coverage tests. It owns only what the browser can change: the theme
  choice (a radio group rather than the rail's cycle button, because three
  states need to be visible at once), **density** (comfortable/compact), the
  **reduced-motion override** (system/reduce/full, defaulting to the system
  preference), **command-palette help** with a button that opens the palette
  through `lamasync:open-command-palette`, the install affordance, the current
  connection state, and **session sign-out** (the same `sign-out.ts`
  implementation the rail and More sheet use, so the LAMA-296 server-first
  ordering exists once). It also renders the preference-ownership table.
  `packages/web-ui/src/preferences.ts` is that table as data — one row per
  preference with its owning store, its layer and where to change it — rendered
  where the question actually comes up and held to invariants by a test. The
  point is the two pairs that look like one setting and are not: browser theme
  vs device appearance, and manual-upload limits vs camera-protection limits.
  Density and motion are separate stores (`density.ts`, `motion.ts`), mirrored
  onto `<html data-density>` / `<html data-motion>` before first paint.
- **Phase 6 — brand assets and the boot state.** The adaptive icon gained its
  `<monochrome>` layer for Android 13 themed icons, derived from the
  foreground's own alpha on the same 108dp canvas so it aligns exactly. The
  notification small icon replaced a placeholder phone glyph with the courier
  mark at 24dp across five densities, and the unused placeholder drawable is
  gone. The llama "nap" pose — exported in LAMA-274 with a loading slot
  explicitly reserved — now carries the app boot state, announced with
  `role="status"` and its animation behind `prefers-reduced-motion`.
- **Phase 7 — installable web app.** `GET /manifest.webmanifest`, `GET /sw.js`
  and `GET /icons/:file` are served from the origin root by `webUiRoutes`; the
  manifest declares `scope` and `start_url` as `/` because the SPA is one
  document with hash routing, so a narrower scope would only break deep links.
  The service worker caches the app shell and nothing else, and is registered
  only outside the Android companion and outside dev. Connectivity became
  honest: `connectivity.ts` separates device-offline, server-unreachable and
  live-updates-paused, and only marks data as possibly stale when a request
  actually failed — `apiFetch` publishes transport outcomes, and a 4xx/5xx
  response deliberately does not count, because the server answered.

Decisions taken during implementation that change the written plan:

1. **Transfers is labelled "manual uploads".** The app has two independent
   transfer policies — `UploadPolicyStore` for manual uploads and
   `AutoProtectSettings.unmeteredOnly`/`chargingOnly` for automatic camera
   protection. One unlabelled pair of switches would claim a device-wide policy
   the app does not have, so the group is labelled and the camera policy keeps
   its own controls on the Camera protection screen, which the group links to.
   Unifying the two stores is a separate, behaviour-changing decision.
2. **Notifications has no stored preference.** The only real state is the
   platform's, so the row reports it and opens the system page that owns it
   rather than adding a setting that could drift.
3. **`windowLayoutInDisplayCutoutMode` is not set.** It needs API 27, and the
   night and version resource qualifiers do not combine as one would hope
   (night mode outranks the version qualifier, so `values-v27` alone is lost in
   dark mode). Content is kept clear of cutouts by `safeDrawing` padding, which
   is the actual requirement.
4. **PWA assets will arrive as server asset routes.** The SPA is built by
   `scripts/inline-web-ui.ts` into a single `index.html` served from `GET /`,
   with no static-asset route, so a manifest, its 192/512 icons and a service
   worker cannot be files today. The agreed approach is new server routes
   serving assets embedded in the binary. Two constraints found while planning
   it: the inliner **deletes** `dist/assets/`, so PWA assets must be emitted
   elsewhere and generated into a module at build time to keep the single-binary
   deployment; and it replaces only Vite's exact `<link rel="stylesheet"
   crossorigin …>` / `<script type="module" crossorigin …>` strings, so a
   `<link rel="manifest">` added to `index.html` survives inlining untouched.
5. **The phone/tablet breakpoint is 640px, not the plan's 600px.** The
   stylesheet already treats 640 as the phone line in five places (the
   dashboard's one-up, the Activity row reflow, the foldered data table). A
   600px nav cutoff would create a 600–639px band with phone-shaped content and
   tablet navigation.
6. **The off-canvas drawer is retired, not restyled.** Below 900px the nav is
   always visible. That removes an open/closed/backdrop state — and with it the
   class of bug where the drawer and back navigation disagree about where the
   user is. The consequence, accepted deliberately: from 640–899px the compact
   rail takes a permanent ~136px column.
7. **Tab taps keep pushing history entries.** Every destination is still a
   `NavLink`, exactly as the rail was. Switching tabs with `replace` would have
   been a silent change to the back contract: browser back would stop walking
   pages, and Android back inside the companion — which drives
   `WebView.goBack` over this same history — would start exiting the app
   instead. Deterministic, and unchanged from the drawer's behaviour.
8. **The table safety net covers the whole sub-900px shell, not just the
   phone.** Fixed table layout plus wrapping cells applies at `max-width:
   899px`. This is not padding: measured at 768px against the demo fleet, the
   new compact rail took `/backends` from 812px to 948px of scroll width and
   pushed `/admin` (772px) and `/apps/backups` (810px) into overflow purely by
   appearing. Below 900px the navigation is no longer a desktop sidebar, so it
   is the point at which tables must respect their column.
9. **The service worker is gated on the shell signal.** It registers only when
   `data-shell !== "android"`. An installed worker caching the app shell inside
   the embedded WebView is a footgun: the native shell reloads that surface on
   every return, so a stale SPA could outlive a server update with no
   user-visible way to clear it. Phase 1 built exactly the signal needed, and
   this was verified in a real browser rather than reasoned about — a browser
   tab registers with scope `/`, the embedded shell registers nothing.
10. **The browser settings route deliberately does not mirror device settings.**
    `#/settings` owns the browser-only layer: the theme choice, density, the
    reduced-motion override, command-palette help, the install affordance,
    connection state, session sign-out and the preference-ownership table.
    Pull-to-refresh, the camera-protection limits and device appearance stay in
    the companion: two controls for one value is how a setting starts "not
    sticking".
11. **PWA assets ship as a generated module of base64 icons.** The server has no
    runtime asset directory — the SPA is inlined into one `index.html` and the
    inliner deletes `dist/assets/` — so icon bytes have to travel inside the
    binary. The alternative, Bun's `with { type: "base64" }` import attribute,
    silently returns a file path on the installed version (1.3.14), so it cannot
    be relied on. Only the unreviewable bytes are generated; the manifest and
    the service worker are hand-written source, and a test fails if the module
    drifts from the PNGs.
12. **The notification small icon is a raster, not a vector.** Android's
    guidance prefers a vector there, and the plan's phase 6 says "vectorise the
    icon concept". A faithful vectorisation needs the designer's source SVG,
    which is not in the repository; guessing one would be a redesign, not a
    conversion. What shipped is a 24dp raster derived mechanically from the
    approved art at five densities. The launcher mark's `lama_courier_launcher`
    raster is in the same position for the same reason. Supplying the source SVG
    is the one art input that would close this out.
13. **The registered service worker is skipped in dev as well as in the
    companion.** `import.meta.env.PROD` gates it because the Vite dev server has
    no `/sw.js`, and a failed registration there would be noise that hides the
    real gate.
14. **Motion gates are written twice, on purpose.** The system
    `prefers-reduced-motion` media query stays the default, and the explicit
    override is a second spelling gated on `<html data-motion>`. A CSS media
    query cannot be unlocked by an attribute, so "allow motion even though the
    system asks for reduce" needs a rule outside the query; conversely the
    system-reduce rules had to become `html:not([data-motion="full"]) …` or
    they would cancel an explicit `full`. `@keyframes` were hoisted out of their
    media queries for the same reason: a conditional keyframes rule would leave
    the override with nothing to run. `motion.ts` resolves the choice, so the
    CSS gates and `prefersReducedMotion()` cannot disagree.
15. **Density tightens surfaces, not type.** The token contract says comfortable
    sizes win over density except inside dense tables, so `compact` only reduces
    page gutters, section rhythm, table-cell padding and device-card padding.
    Shrinking type would trade legibility for a preference nobody asked for, and
    changing root tokens would have rippled into the native palette mirror.
16. **Activation prunes only `lamasync-shell-*` caches.** Cache Storage is
    origin-wide: deleting every name but the current one would erase caches
    belonging to another app or worker on the same origin. The worker now owns a
    name prefix and deletes only its own superseded shell caches.

### Phase 8 — what is verified and what still needs a human

Verified and recorded in `docs/android-mobile-ux-artifacts/`: layout at 360,
412, 600, 768, 1280 and both landscape sizes (12 routes each, machine-checked
for horizontal overflow and for sub-48px phone targets); light and dark; the
install prompt being offered by Chrome itself; the offline shell boot with its
honest banner; the launcher mark inside circle, squircle, rounded-square and
teardrop masks; the notification glyph at true 24px on dark and light status
bars; and the enrollment surface at font scale 2.0.

Still needs a device or a person, and is listed as open in `docs/status.md`:
TalkBack over the shell and the mobile nav; gesture vs 3-button navigation;
launching the installed PWA; Android back inside the embedded WebView after the
nav change; and font scale 2.0 on the paired managed shell.

## Outcome

Make the Android companion feel like one coherent LamaSync product while keeping
the existing security boundary intact: Compose owns device-local capabilities
and the hardened WebView owns fleet administration. The visual direction is a
**warm homelab field journal** — Material 3 ergonomics, LamaSync's moss/clay
palette, restrained editorial type, and small moments of llama personality.

The two generated UI studies and launcher-icon study in
`docs/android-mobile-ux-artifacts/` are direction references, not pixel-perfect
specifications. Preserve their hierarchy and tone; correct generated copy and
geometry in implementation.

## Research conclusions

- Android 15 enforces edge-to-edge for target SDK 35. Use `enableEdgeToEdge()`,
  `Scaffold`, and explicit safe/IME insets; backgrounds may extend behind system
  bars, but taps and important content must not.
- On compact widths, a Material navigation bar is the right primary web
  navigation pattern. LamaSync has too many destinations for a single bar, so
  show four high-frequency destinations plus **More**; do not squeeze eleven
  labels into it.
- Keep Material Symbols self-hosted and subset, or continue the existing inline
  SVG approach. The variable `FILL` axis gives selected-state animation without
  introducing an animation runtime.
- Rive is capable of shared Android/web state-machine animation, but adds WASM,
  native runtime, authoring and test cost. Do not add it in phase 1. Animate the
  existing SVG llama with CSS/Compose transforms; pause off-screen and honor
  reduced motion. Reconsider Rive only after measuring a real, approved `.riv`.
- Browser polish is a manifest + icon + theme/safe-area job before it is an
  offline cache job. LamaSync's live fleet data must never imply stale data is
  current, so a service worker should initially cache only immutable shell
  assets, never authenticated API responses.

Primary references:

- Android edge-to-edge setup: https://developer.android.com/develop/ui/compose/system/setup-e2e
- Android edge-to-edge design: https://developer.android.com/design/ui/mobile/guides/layout-and-content/edge-to-edge
- Compose navigation bar: https://developer.android.com/develop/ui/compose/components/navigation-bar
- Material Symbols: https://developers.google.com/fonts/docs/material_symbols
- Web app manifest/display: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/index.html
- CSS safe-area variables: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env
- Rive runtime/reduced-motion guidance: https://rive.app/docs/getting-started/best-practices

## Product architecture

### Native shell (Compose)

The Android shell remains deliberately thin and never receives fleet-admin
credentials through a new bridge.

- Replace the current text-button strip with a small Material 3 top app bar:
  LamaSync/host title, connection-state dot, refresh icon, and overflow menu.
- Overflow actions: Uploads, Camera protection, Settings, Open in browser.
- Android back first navigates WebView history, then exits the management
  surface; native child pages use normal up navigation. Add predictive-back
  support where the current Compose version permits it.
- Add pull-to-refresh around the WebView. Enable only when the page is at scroll
  top; reload the current same-origin URL; show the llama/sync indicator briefly.
- Create a real native Settings screen. Groups:
  Appearance (system/light/dark), Transfers, Camera protection, Notifications,
  Browser experience (pull-to-refresh, open external links), Connection, About,
  and the destructive Disconnect action.
- Settings must reuse existing stores/view-model operations rather than create a
  second source of truth. Server, device id, app version and check-in belong in
  Connection/About detail rows. Never display either credential.
- Use dynamic color only as an opt-in; default to the LamaSync palette so the
  WebView and Compose surfaces do not visibly switch brands.

### Embedded and browser web UI

- Add an explicit, non-secret display-mode signal from native to web (for
  example a request header or initial URL parameter consumed into session/UI
  state). It may affect presentation only, never authorization.
- At `< 600px`, replace the hamburger-first drawer with a fixed bottom navigation
  bar: Home, Devices, Protect, Activity, More. `More` opens an accessible bottom
  sheet containing Managed folders, Conflicts, Storage destinations, Browse
  recovery data, App backups, App templates and Admin.
- At `600–899px`, use a compact navigation rail. At `>= 900px`, preserve the
  current grouped rail. Keep `GROUPS` as the single route source so the command
  palette, rail, bottom bar and More sheet cannot drift.
- Give every page a mobile title/action contract: one primary action, overflow
  for secondary actions, cards/lists instead of horizontal tables, sticky
  bottom confirmation only when an operation genuinely needs it.
- Add safe-area padding with `env(safe-area-inset-*)`, `100dvh` fallbacks, larger
  48px touch targets, `overscroll-behavior`, and input/keyboard-safe spacing.
- Add a web Settings route for browser-only preferences: theme, density,
  reduced-motion override (default system), command-palette help, install app,
  and session sign-out. Do not duplicate native transfer/camera controls there.
- Add `manifest.webmanifest`, `theme-color` variants, favicons, 192/512 regular
  and maskable icons, and `display: standalone`. Keep network/API offline states
  explicit and timestamped.

## Visual and motion system

- Retain current color tokens and four-surface hierarchy. Raise mobile radii to
  12/16/24dp selectively, not on every row.
- Serif is reserved for one emotional sentence per major surface. Navigation,
  settings, controls and data remain in the humanist sans family.
- Use llamas only for boot/loading, empty, success and recoverable-error moments.
  Never place them in routine dense data rows.
- Motion vocabulary: sync loop rotates 600–900ms; llama ear/tail settles once;
  success hop plays once; error slip plays once then rests. No perpetual ambient
  motion. Under reduced motion, cross-fade or render the resting frame.
- Prefer CSS/inline SVG and Compose vector animation in phase 1. Material Symbols
  may be self-hosted as a very small named subset; do not load the full font.

## Asset handoff

| Asset | Role | Implementation treatment |
| --- | --- | --- |
| `mobile-home-preview.png` | Mobile home/navigation direction | Reference only |
| `mobile-settings-preview.png` | Native Settings direction | Reference only |
| `android-icon-concept.png` | Launcher mark source | Redraw as vector foreground + monochrome layer; validate all adaptive masks |
| `lama-courier-color.png` | Approved full-body courier identity | Current Android launcher source and large brand moments |
| `lama-courier-dark-moss.png` / `lama-courier-light-teal.png` | Web masthead variants | Exact one-color alpha-mask derivatives used by `BrandLockup` |
| `courier-standing.png` / `courier-seated-file.png` | Dashboard and empty-state accents | Transparent decorative artwork; keep out of dense product chrome |
| Existing `Llama.tsx` poses | Product empty/loading moments | Keep `currentColor`; add one-shot CSS motion |
| Existing umbrella/slip PNG studies | Illustration reference | Redraw selected moments as optimized SVG/Lottie only if needed; do not ship giant source PNGs |
| Material Symbols subset | Navigation/settings glyphs | Pin and self-host Apache-2.0 assets; record license |

Required icon exports after the concept is vectorized:

- Android adaptive foreground, background color and monochrome themed-icon layer.
- Legacy mipmap PNG densities for API 26 fallback/testing.
- Web favicon SVG + 32px PNG, Apple touch icon 180px, PWA 192px and 512px,
  plus separate 192/512 maskable exports with safe-zone validation.
- Notification icon: one-color white silhouette, transparent background; never
  reuse the full-color launcher asset.

Status as shipped (phases 6–7):

| Export | State |
| --- | --- |
| Android adaptive foreground + background colour | Shipped (raster foreground at five densities) |
| Android `<monochrome>` themed-icon layer | Shipped, derived from the foreground alpha on the same canvas |
| Legacy mipmap densities | Shipped (`drawable-*dpi/lama_courier_launcher.png`) |
| PWA 192 + 512 (`any`) and 512 (`maskable`) | Shipped, maskable safe zone measured (mark radius 72% of half-canvas; limit 80%) |
| Notification white silhouette | Shipped at five densities, checked at true 24px on dark and light status bars |
| Vectorised concept (source SVG) | **Open** — needs the designer's source; see decision 12 |
| Favicon SVG + 32px PNG, Apple touch 180px, maskable 192px | **Open** — not required by any gate; add if an iOS or favicon requirement appears |

Regenerating the PNG set is a documented one-off art step, not part of the
build: see `packages/web-ui/src/assets/brand/README.md`. The base64 embedding
the server needs IS part of the build and is idempotent —
`scripts/gen-pwa-assets.ts`, with a test that fails if the generated module
drifts from the PNGs.

## Luna implementation sequence

1. **Foundations:** edge-to-edge Compose scaffold, dark theme, shared palette,
   native top app bar, back handling and embedded display-mode signal.
2. **Native information architecture:** Navigation Compose routes for Manage,
   Uploads, Camera protection, Settings, Connection and About; migrate current
   callbacks without changing repository/security behavior.
3. **Mobile web navigation:** derive compact destinations from `GROUPS`; bottom
   bar + More sheet below 600px, compact rail on tablet, existing rail on desktop.
4. **Responsive page pass:** Dashboard, Devices, Protect/Backups, Activity, then
   every More destination. Remove horizontal overflow and prioritize one action.
5. **Settings:** native device settings plus browser-only `/settings`; document
   which store owns every preference.
6. **Brand assets/motion:** vectorize icon concept, add adaptive/PWA/notification
   exports, wire llama boot/empty/error/success states with reduced-motion gates.
7. **Browser comforts:** manifest, theme colors, install affordance, safe areas,
   asset-only service worker, honest reconnect/offline state.
8. **Polish and evidence:** screenshots at 360x800, 412x915, 600x960, 768x1024
   and desktop; light/dark; gesture and 3-button navigation; TalkBack; font scale
   1.3/2.0; keyboard; rotation; WebView and Chrome installed-PWA modes.

## Acceptance gates

- No new JS/native bridge can invoke privileged actions or expose credentials.
- Every existing web route remains reachable on phone in at most two navigation
  actions; current deep links still resolve.
- No content or target sits beneath cutouts/system bars; no horizontal page
  scrolling at 360 CSS px; all primary targets are at least 48dp/CSS px.
- Android back, browser back and deep-link return behavior are deterministic.
- Pull-to-refresh cannot fire while a nested page is scrolled away from top.
- Loading, offline, empty, success and error are visually distinct without color
  alone, and all animation respects reduced motion.
- Launcher icon passes circle/squircle/rounded-square/teardrop masks and Android
  monochrome themed-icon preview; notification icon is legible at 24dp.
- Web manifest passes Chrome Application-panel checks; installed mode has correct
  title, icon, theme color and launch scope. Authenticated API data is not cached.
- Existing typecheck, web build, Android unit/instrumented tests and strict skill
  drift pass; add focused navigation/settings/back/refresh tests.

## Likely files

- `android/app/src/main/java/app/lamasync/companion/ui/MainActivity.kt`
- `android/app/src/main/java/app/lamasync/companion/ui/ManagementScreens.kt`
- new native navigation/settings/theme components under `android/.../ui/`
- `android/app/src/main/java/app/lamasync/companion/web/HardenedWebView.kt`
- Android manifest/theme/mipmap/drawable resources
- `packages/web-ui/src/App.tsx`
- `packages/web-ui/src/components/Nav.tsx`
- `packages/web-ui/src/index.css`
- new web settings/page-shell/mobile-more components
- `packages/web-ui/index.html` and new public manifest/icon assets
- focused web and Android tests plus relevant documentation

## Deliberate non-goals

- No redesign of API, auth, enrollment, upload or media-protection contracts.
- No cached authenticated API payloads or false offline-management promise.
- No full native rewrite of fleet administration.
- No Rive dependency until a measured animation prototype justifies it.
- No rollout/deploy or production-device changes in this worktree.
