# LamaSync Android + mobile web UX plan

Status: design/research handoff for Luna. The approved courier identity,
theme-specific web-header marks, and Android launcher foreground are already
integrated in the `android-stage-2` worktree; the broader UX implementation has
not started.
Date: 2026-09-10

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
