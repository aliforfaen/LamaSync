// Core wire/DB types — single source of truth for the whole system.

export type HostStatus = "online" | "offline" | "degraded" | "unknown";

export type FolderType = "sync" | "mount" | "backup" | "dotfile";

export type OperationStatus =
  | "started"
  | "success"
  | "failed"
  | "conflict";

export type ConflictStrategy =
  | "newer_wins"
  | "source_wins"
  | "keep_both"
  | "manual";

export interface Host {
  id: string;
  hostname: string;
  tailnetIp?: string | null;
  lastSeen?: number | null;
  status: HostStatus;
}

export interface Folder {
  id: string;
  name: string;
  type: FolderType;
  createdAt?: number;
}

export interface FolderAssignment {
  id: string;
  folderId: string;
  hostId: string;
  role: string; // "source" | "target" | "both"
  localPath: string;
  remoteName?: string | null;
  syncExpr?: string | null; // cron expression
  enabled: boolean;
  conflictStrategy?: ConflictStrategy | null;
  preSyncCmd?: string | null;
  postSyncCmd?: string | null;
  ignorePath?: string | null; // path to .lamasyncignore relative to localPath
  timeoutSec?: number | null; // per-operation timeout
}

export interface DotfileManifest {
  id: string;
  hostId: string;
  appName: string;
  paths: string[];
  schedule?: string | null;
}

export interface DotfileVersion {
  id: string;
  manifestId: string;
  timestamp: number;
  tarballPath: string;
  sizeBytes?: number | null;
  checksum?: string | null;
  description?: string | null; // optional label, e.g. "before nvim plugin rewrite"
}

export interface OperationLog {
  id: number;
  timestamp: number;
  hostId: string;
  folderId?: string | null;
  operation: string;
  status: OperationStatus;
  summary?: string | null;
  details?: string | null;
  durationMs?: number | null;
}

// API request/response shapes
export interface HealthResponse {
  status: "ok";
  hostCount: number;
  onlineCount: number;
  hosts: Host[];
}

export interface HostConfig {
  host: Host;
  assignments: FolderAssignment[];
  folders: Folder[];
  manifests: DotfileManifest[];
  rcloneConfig: string;
  serverTailnetIp: string | null;
}

export interface HealthReport {
  hostId: string;
  timestamp: number;
  status: HostStatus;
  uptimeSec?: number;
}

export interface OperationReport {
  hostId: string;
  folderId?: string | null;
  operation: string;
  status: OperationStatus;
  summary?: string | null;
  details?: string | null;
  timestamp?: number;
  durationMs?: number | null;
}

// WebSocket event payload broadcast on /api/v1/ws
export type WSEvent =
  | { kind: "operation"; entry: OperationLog }
  | { kind: "host"; host: Host };

export interface PruneResult {
  deleted: number;
  olderThanMs: number;
}
