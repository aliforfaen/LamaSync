// Workstream 2 (onboarding & explanations): the single source of truth for
// plain-language explanations in the web UI. Every form hint, glossary
// tooltip, and coaching line should read from here. Records are typed
// against the core union types where they exist. Keep every hint to one
// sentence — if an explanation needs two, the glossary entry is wrong.

import type { BackendKind, ConflictStrategy, FolderType } from "@lamasync/core";

export const FOLDER_TYPE_HINTS: Record<FolderType, string> = {
  sync: "Two-way sync between hosts — edits anywhere propagate (rclone bisync).",
  mount: "Remote files mounted as a local directory — nothing stored on this host.",
  backup: "One-way versioned backup to the server (restic).",
  dotfile: "App config files backed up as versioned tarballs.",
  git: "A git working copy kept in sync between hosts.",
};

export const BACKEND_KIND_HINTS: Record<BackendKind, string> = {
  s3: "S3-compatible object storage (Exoscale, AWS, other).",
  local: "A directory path — must exist at the same location on every assigned host.",
  nfs: "An NFS export mounted locally — same path on every assigned host.",
  restic: "Central backup repository — folders use it as the default backup target.",
};

// Moved verbatim from AssignmentEditor.tsx (workstream 1) — the best copy in
// the app. AssignmentEditor re-imports these; do not paraphrase them here.

export const ROLE_HINTS: { value: string; label: string; hint: string }[] = [
  {
    value: "source",
    label: "Source",
    hint: "This host's copy is authoritative — local changes push to peers.",
  },
  {
    value: "target",
    label: "Target",
    hint: "This host receives changes — local edits on it are overwritten.",
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
    label: "Newer wins",
    hint: "Keep whichever copy was modified most recently.",
  },
  {
    value: "source_wins",
    label: "Source wins",
    hint: "Always keep the source host's copy.",
  },
  {
    value: "keep_both",
    label: "Keep both",
    hint: "Keep the losing copy under a conflict-<n> name instead of deleting it.",
  },
  {
    value: "manual",
    label: "Manual",
    hint: "Never auto-resolve — record the conflict for manual review.",
  },
];

export const MISC_HINTS = {
  configRevision:
    "Bumps whenever server-side config changes — daemons re-pull their config within ~5 minutes.",
  queuedAction:
    "Actions are queued and run on the daemon within ~30 seconds — nothing happens instantly.",
  dotfileManifest:
    "Decides which paths of an app's config get backed up, on which hosts, on what schedule.",
  dotfileOverride:
    "A host-scoped manifest overrides the global one with the same app name.",
  cacheProfile:
    "rclone VFS cache: normal = balanced, media = aggressive read-ahead for streaming, minimal = lowest disk use.",
} as const;
