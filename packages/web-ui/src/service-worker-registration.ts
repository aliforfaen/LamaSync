// LAMA-329 phase 7: service worker registration, gated.
//
// The gate that matters is the embedded shell one (plan decision 9): the
// companion reloads the management surface on every return, so a service worker
// caching the app shell INSIDE the Android WebView can serve a stale SPA that
// outlives a server update, with no user-visible way to clear it. The shell
// signal built in phase 1 is exactly what distinguishes the two cases.

import { isEmbeddedShell } from "./shell.ts";

export interface ServiceWorkerEnvironment {
  embeddedShell: boolean;
  /** Vite's production build flag: the dev server has no /sw.js to serve. */
  production: boolean;
  secureContext: boolean;
  serviceWorkerSupported: boolean;
}

/**
 * Whether the shell cache should be used in this context.
 *
 * Kept pure and exported so the embedded-shell rule is testable without a
 * browser: it is the difference between a cached app and a stale app.
 */
export function shouldRegisterServiceWorker(environment: ServiceWorkerEnvironment): boolean {
  if (environment.embeddedShell) return false;
  if (!environment.production) return false;
  if (!environment.secureContext) return false;
  return environment.serviceWorkerSupported;
}

export type ServiceWorkerResult = "registered" | "skipped" | "failed";

/** Registers the shell cache when the environment allows it. Never throws. */
export async function registerServiceWorker(): Promise<ServiceWorkerResult> {
  const environment: ServiceWorkerEnvironment = {
    embeddedShell: isEmbeddedShell(),
    production: Boolean(import.meta.env.PROD),
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    serviceWorkerSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
  };
  if (!shouldRegisterServiceWorker(environment)) return "skipped";

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    return "registered";
  } catch {
    // A failed registration must not break the app: the shell cache is an
    // optimisation, and offline behaviour stays honest either way.
    return "failed";
  }
}
