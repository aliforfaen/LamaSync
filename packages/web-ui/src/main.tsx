import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Web UI root element missing");
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
