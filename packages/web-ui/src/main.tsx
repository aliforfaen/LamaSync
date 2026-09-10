import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, loadThemeChoice } from "./theme.ts";
import { consumeShellSignal } from "./shell.ts";
import "./index.css";

applyTheme(loadThemeChoice());

// LAMA-329: resolve and persist the embedded-shell signal before the first
// paint, so styles can branch on <html data-shell> without a flash. The
// companion adds the parameter to the initial document URL only; the value is
// consumed into session state here and never reaches an API request.
consumeShellSignal();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Web UI root element missing");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
