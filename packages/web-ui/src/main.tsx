import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, loadThemeChoice } from "./theme.ts";
import { applyDensity, loadDensityChoice } from "./density.ts";
import { applyMotion, loadMotionChoice } from "./motion.ts";
import { clearStoredBearerForEmbeddedShell } from "./api.ts";
import { consumeShellSignal } from "./shell.ts";
import { registerServiceWorker } from "./service-worker-registration.ts";
import "./index.css";

applyTheme(loadThemeChoice());

// LAMA-329 phase 5: density and the reduced-motion override are mirrored onto
// <html> before the first paint, so neither flashes the default and then
// corrects itself.
applyDensity(loadDensityChoice());
applyMotion(loadMotionChoice());

// LAMA-329: resolve and persist the embedded-shell signal before the first
// paint, so styles can branch on <html data-shell> without a flash. The
// companion adds the parameter to the initial document URL only; the value is
// consumed into session state here and never reaches an API request.
const shellMode = consumeShellSignal();

// A freshly re-paired companion must always discover its new cookie session.
// The WebView may retain an older browser bearer in origin-scoped DOM storage;
// leaving it in place would intentionally make it win over the cookie and
// yield a 403 for a device-scoped key. This only clears local bearer storage;
// it is not an authorization input and cannot create a session.
if (shellMode === "embedded") {
  clearStoredBearerForEmbeddedShell();
}

// LAMA-329 phase 7: cache the application shell so the app can boot offline.
// Skipped inside the Android companion (plan decision 9) and outside a
// production secure context; `service-worker-registration.ts` owns the rule and
// never throws.
void registerServiceWorker();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Web UI root element missing");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
