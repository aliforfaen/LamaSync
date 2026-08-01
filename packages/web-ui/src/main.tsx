import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, loadThemeChoice } from "./theme.ts";
import "./index.css";

applyTheme(loadThemeChoice());

const container = document.getElementById("root");
if (!container) {
  throw new Error("Web UI root element missing");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
