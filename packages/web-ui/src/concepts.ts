// Workstream 2 (onboarding & explanations): the single source of truth for
// plain-language explanations in the web UI. Every form hint, glossary
// tooltip, and coaching line should read from here. Records are typed
// against the core union types where they exist. Keep every hint to one
// sentence — if an explanation needs two, the glossary entry is wrong.

import type { BackendKind, ConflictStrategy, FolderType } from "@lamasync/core";

export const FOLDER_TYPE_HINTS: Record<FolderType, string> = {
  sync: "Two-way sync between devices — edits anywhere propagate.",
  mount: "Remote files shown as a local directory — read-only on this device, nothing stored locally.",
  backup: "One-way versioned backup to the server (restic).",
  dotfile: "Application settings backed up as versioned archives.",
  git: "A git working copy kept in sync between devices.",
};

export const BACKEND_KIND_HINTS: Record<BackendKind, string> = {
  s3: "S3-compatible object storage (Backblaze B2, Exoscale, AWS, and other providers).",
  local: "A directory path — must exist at the same location on every device set up to use it.",
  nfs: "An NFS export mounted locally — same path on every device set up to use it.",
  restic: "Central backup repository — folders use it as the default backup target.",
};

// Moved verbatim from AssignmentEditor.tsx (workstream 1) — the best copy in
// the app. AssignmentEditor re-imports these; do not paraphrase them here.

export const ROLE_HINTS: { value: string; label: string; hint: string }[] = [
  {
    value: "source",
    label: "Source",
    hint: "This device's copy is authoritative — local changes push to peers.",
  },
  {
    value: "target",
    label: "Target",
    hint: "This device receives changes — local edits on it are overwritten.",
  },
  {
    value: "both",
    label: "Both",
    hint: "Two-way sync — local edits merge with peers (best for personal files).",
  },
];

export const CONFLICT_STRATEGY_HINTS: {
  value: ConflictStrategy;
  label: string;
  hint: string;
}[] = [
  {
    value: "newer_wins",
    label: "Keep newest",
    hint: "Keep whichever copy was modified most recently.",
  },
  {
    value: "source_wins",
    label: "Source wins",
    hint: "Always keep this device's copy.",
  },
  {
    value: "keep_both",
    label: "Keep both",
    hint: "The losing copy is kept under a conflict-<n> name instead of being deleted.",
  },
  {
    value: "manual",
    label: "Ask me",
    hint: "Never auto-resolve — the conflict waits for you to decide.",
  },
];

export const MISC_HINTS = {
  configRevision:
    "Bumps whenever server-side config changes — devices re-pull their config within ~5 minutes.",
  queuedAction:
    "Actions are queued and run on the device within ~30 seconds — nothing happens instantly.",
  dotfileManifest:
    "Decides which paths of an app's settings get backed up, on which devices, on what schedule.",
  dotfileOverride:
    "A device-scoped override takes precedence over the global one with the same app name.",
  cacheProfile:
    "rclone VFS cache: normal = balanced, media = aggressive read-ahead for streaming, minimal = lowest disk use.",
} as const;
