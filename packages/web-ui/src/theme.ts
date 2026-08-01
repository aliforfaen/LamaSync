export type ThemeChoice = "dark" | "light" | "system";

const THEME_KEY = "lamasync-theme";
const VALID_CHOICES: ThemeChoice[] = ["dark", "light", "system"];

let mediaQuery: MediaQueryList | null = null;
let mediaListener: (() => void) | null = null;

function resolveSystem(): "dark" | "light" {
  if (typeof window === "undefined") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

function setRootTheme(theme: "dark" | "light"): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
  }
}

function subscribeSystem(): void {
  unsubscribeSystem();
  if (typeof window === "undefined") {
    return;
  }
  mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  mediaListener = () => setRootTheme(resolveSystem());
  mediaQuery.addEventListener("change", mediaListener);
}

function unsubscribeSystem(): void {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener("change", mediaListener);
  }
  mediaQuery = null;
  mediaListener = null;
}

export function loadThemeChoice(): ThemeChoice {
  if (typeof localStorage === "undefined") {
    return "system";
  }
  const stored = localStorage.getItem(THEME_KEY);
  if (stored && (VALID_CHOICES as readonly string[]).includes(stored)) {
    return stored as ThemeChoice;
  }
  return "system";
}

export function saveThemeChoice(choice: ThemeChoice): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(THEME_KEY, choice);
  }
}

export function applyTheme(choice: ThemeChoice): void {
  if (choice === "system") {
    setRootTheme(resolveSystem());
    subscribeSystem();
  } else {
    unsubscribeSystem();
    setRootTheme(choice);
  }
}
