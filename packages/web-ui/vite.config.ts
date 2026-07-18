import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the SPA so it can be embedded as a single string in the compiled
// server binary. Asset inlining is handled by scripts/inline-web-ui.ts which
// runs after `vite build` via the package.json `build` script.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/v1": {
        target: "http://127.0.0.1:8080",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
