// LAMA-263 — curated app-presets catalog.
//
// Decision locked 2026-08-22: ship CURATED, not a registry. This static
// module is the source of truth for the gallery and for the "one-click
// backup" payload. If a community-extensible registry is wanted later, this
// interface is the seam (swap the array for a fetched catalog).
//
// Paths are appdata locations per OS. They are suggestions the user can
// adjust before backing up; LamaSync backs them up as app-settings backups
// (a dotfile-style manifest per device).

export type OSKey = "linux" | "macos" | "windows";

export interface PresetPaths {
  linux?: string[];
  macos?: string[];
  windows?: string[];
}

export interface AppPreset {
  id: string;
  /** Display name shown in the gallery. */
  name: string;
  /** One-sentence "what this backs up". */
  blurb: string;
  /** External install/docs link (opens in a new tab). */
  docsUrl: string;
  /** Default name for the app-settings backup entry. */
  suggestedFolderName: string;
  /** Per-OS appdata paths; linux is the fallback when an OS is absent. */
  paths: PresetPaths;
}

export const APP_PRESETS: AppPreset[] = [
  {
    id: "vscode",
    name: "VS Code",
    blurb: "Settings, keybindings, snippets and extensions list.",
    docsUrl: "https://code.visualstudio.com/docs/setup/setup-overview",
    suggestedFolderName: "VS Code settings",
    paths: {
      linux: [
        "~/.config/Code/User/settings.json",
        "~/.config/Code/User/keybindings.json",
        "~/.config/Code/User/snippets",
      ],
      macos: [
        "~/Library/Application Support/Code/User/settings.json",
        "~/Library/Application Support/Code/User/keybindings.json",
        "~/Library/Application Support/Code/User/snippets",
      ],
      windows: [
        "%APPDATA%\\Code\\User\\settings.json",
        "%APPDATA%\\Code\\User\\keybindings.json",
        "%APPDATA%\\Code\\User\\snippets",
      ],
    },
  },
  {
    id: "neovim",
    name: "Neovim",
    blurb: "Your entire Neovim config tree (init.lua + plugins).",
    docsUrl: "https://neovim.io/doc/user/starting.html#initialization",
    suggestedFolderName: "Neovim config",
    paths: {
      linux: ["~/.config/nvim"],
      macos: ["~/.config/nvim"],
      windows: ["~/AppData/Local/nvim"],
    },
  },
  {
    id: "zsh",
    name: "Zsh",
    blurb: "Shell rc, aliases, and your oh-my-zsh or zsh theme.",
    docsUrl: "https://zsh.sourceforge.io/",
    suggestedFolderName: "Zsh config",
    paths: {
      linux: ["~/.zshrc", "~/.zsh_aliases", "~/.config/zsh", "~/.oh-my-zsh"],
      macos: ["~/.zshrc", "~/.zsh_aliases", "~/.config/zsh", "~/.oh-my-zsh"],
      windows: ["~/.zshrc"],
    },
  },
  {
    id: "firefox",
    name: "Firefox",
    blurb: "User chrome, container config and per-profile preferences.",
    docsUrl: "https://support.mozilla.org/kb/profiles-where-firefox-stores-user-data",
    suggestedFolderName: "Firefox profile",
    paths: {
      linux: ["~/.mozilla/firefox"],
      macos: ["~/Library/Application Support/Firefox"],
      windows: ["%APPDATA%\\Mozilla\\Firefox"],
    },
  },
  {
    id: "git",
    name: "Git config",
    blurb: "Global gitconfig and ignore rules — not your repos.",
    docsUrl: "https://git-scm.com/docs/git-config",
    suggestedFolderName: "Git config",
    paths: {
      linux: ["~/.gitconfig", "~/.gitignore_global"],
      macos: ["~/.gitconfig", "~/.gitignore_global"],
      windows: ["~/.gitconfig", "~/.gitignore_global"],
    },
  },
  {
    id: "tmux",
    name: "tmux",
    blurb: "Your tmux.conf and any tmux plugin manager dir.",
    docsUrl: "https://github.com/tmux/tmux/wiki",
    suggestedFolderName: "tmux config",
    paths: {
      linux: ["~/.tmux.conf", "~/.config/tmux"],
      macos: ["~/.tmux.conf", "~/.config/tmux"],
      windows: ["~/.tmux.conf"],
    },
  },
];

/** Detect the current OS for default path selection (browser context). */
export function detectOs(): OSKey {
  if (typeof navigator === "undefined") return "linux";
  const platform = (navigator.platform || "").toLowerCase();
  const ua = (navigator.userAgent || "").toLowerCase();
  if (platform.includes("mac") || ua.includes("mac os")) return "macos";
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  return "linux";
}

/** Resolve the paths to offer for an app on a given OS (linux fallback). */
export function pathsForOs(preset: AppPreset, os: OSKey): string[] {
  return preset.paths[os] ?? preset.paths.linux ?? [];
}
