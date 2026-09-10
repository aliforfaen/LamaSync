// LAMA-329 phase 5: one implementation of "sign out".
//
// LAMA-296 requires the server-side session invalidation to run BEFORE any local
// clear: the browser cannot delete the HttpOnly session cookie itself, so a
// local clear alone would log straight back in on reload. That ordering is
// load-bearing, and sign-out is now reachable from three surfaces — the rail
// footer, the phone More sheet and the Settings page. A copy per surface would
// be three places to get it wrong, so the surfaces call this and own only their
// error presentation.

import { clearApiKey, getAuthMode, sessionLogout } from "./api.ts";

export type SignOutResult = "signed-out" | "failed";

export const SIGN_OUT_FAILED_MESSAGE =
  "Couldn't sign out — the server didn't confirm. The session is still active; try again when connected.";

/**
 * Invalidate the session server-side, then clear local state. Bearer mode has
 * no server-side session to end, so clearing the stored key is the whole job.
 */
export async function performSignOut(): Promise<SignOutResult> {
  if (getAuthMode() === "session") {
    const result = await sessionLogout();
    return result === "failed" ? "failed" : "signed-out";
  }
  clearApiKey();
  return "signed-out";
}
