// LAMA-329 phase 5: which store owns every preference.
//
// The plan asks for this to be documented, and the reason is that the product
// now spans three storage layers that are easy to confuse: browser storage in
// the SPA, Android preferences on the device, and server-side state. A
// preference written to the wrong layer either silently fails to persist or
// worse, appears to persist on one device and not another.
//
// This module IS the documentation: the Settings screen renders this table, so
// an operator can see the answer where the question comes up, and
// `preferences.test.ts` holds the table to its invariants. Keep it in step with
// the native Settings screen (android/.../ui/SettingsScreen.kt) and
// docs/android-mobile-ux-plan.md.

export type PreferenceScope = "web" | "native" | "server";

export interface PreferenceOwner {
  /** Stable id, used as the React key and by tests. */
  id: string;
  /** What the user recognises it as. */
  label: string;
  /** The single place the value lives. */
  owner: string;
  scope: PreferenceScope;
  /** Where it is edited, so the answer is actionable. */
  editedIn: string;
  notes: string;
}

export const PREFERENCES: PreferenceOwner[] = [
  {
    id: "web-theme",
    label: "Theme (this browser)",
    owner: 'localStorage "lamasync-theme"',
    scope: "web",
    editedIn: "Settings → Appearance, the rail theme button",
    notes:
      "One value per browser profile. The embedded Android shell has its own appearance setting, so the two can differ on purpose.",
  },
  {
    id: "web-density",
    label: "Density (this browser)",
    owner: 'localStorage "lamasync-density"',
    scope: "web",
    editedIn: "Settings → Density and motion",
    notes:
      "Comfortable is the default. Compact tightens spacing, not type size, so it cannot make fleet data unreadable.",
  },
  {
    id: "web-motion",
    label: "Reduced-motion override",
    owner: 'localStorage "lamasync-motion"',
    scope: "web",
    editedIn: "Settings → Density and motion",
    notes:
      "Defaults to the system preference; the override can force reduce or full either way. Mirrored onto <html data-motion> and read by both the CSS motion gates and prefersReducedMotion().",
  },
  {
    id: "api-key",
    label: "API key / session",
    owner:
      'sessionStorage "lamasync_api_key", localStorage "lamasync_api_key_persist" when "remember me" is on',
    scope: "web",
    editedIn: "Sign in; signed out from Settings → Session, the rail and the More sheet",
    notes:
      "Never sent anywhere but the API. Session mode instead uses the server-issued HttpOnly cookie below.",
  },
  {
    id: "web-session",
    label: "Web session cookie",
    owner: "Server-issued HttpOnly cookie for the enrolled origin",
    scope: "server",
    editedIn: "Settings → Session, the rail and the More sheet; mobile enrollment",
    notes:
      "Cannot be cleared from JavaScript, which is why sign-out invalidates it on the server first and only then clears local state (LAMA-296).",
  },
  {
    id: "native-appearance",
    label: "Appearance mode (this device)",
    owner: "Android AppearanceStore",
    scope: "native",
    editedIn: "Companion → Settings → Appearance",
    notes:
      "Includes the dynamic-colour opt-in. Drives the Compose theme only; it does not restyle the embedded web UI.",
  },
  {
    id: "native-shell",
    label: "Pull-to-refresh, open links externally",
    owner: "Android ShellPreferencesStore",
    scope: "native",
    editedIn: "Companion → Settings → Browser experience",
    notes: "Affects only how the companion presents the embedded web UI.",
  },
  {
    id: "upload-policy",
    label: "Manual upload constraints",
    owner: "Android UploadPolicyStore",
    scope: "native",
    editedIn: "Companion → Settings → Transfers",
    notes:
      "Applies to uploads a person starts by hand. Separate from the camera-protection policy below — they are deliberately two policies.",
  },
  {
    id: "camera-policy",
    label: "Camera protection constraints",
    owner: "Android AutoProtectSettings",
    scope: "native",
    editedIn: "Companion → Settings → Camera protection",
    notes:
      "Automatic camera backup: unmetered-only and charging-only. Enforced by the work scheduler, not by the UI.",
  },
  {
    id: "notifications",
    label: "Notification permission",
    owner: "Platform (Android app notification settings)",
    scope: "native",
    editedIn: "System settings, opened from the companion",
    notes:
      "Deliberately not mirrored into an app preference: a copy would drift from the only state that governs delivery.",
  },
  {
    id: "demo-data",
    label: "Demo fleet",
    owner: "Server database rows flagged demo = 1",
    scope: "server",
    editedIn: "Dashboard → demo banner (seed / delete)",
    notes:
      "Seeded and removed by an API call. Demo rows never touch a real rclone backend and no daemon acts on them.",
  },
  {
    id: "shell-cache",
    label: "Application-shell cache",
    owner: 'Browser Cache Storage, "lamasync-shell-v1"',
    scope: "web",
    editedIn: "Not user-facing; cleared by a shell version bump",
    notes:
      "Holds the app shell ONLY so the UI can boot offline. Fleet data is never cached — see the never-cache rule in the service worker.",
  },
];

/** Preferences the browser version of the app can actually change itself. */
export function browserEditablePreferences(): PreferenceOwner[] {
  return PREFERENCES.filter((preference) => preference.scope === "web");
}

export function preferencesByScope(scope: PreferenceScope): PreferenceOwner[] {
  return PREFERENCES.filter((preference) => preference.scope === scope);
}
