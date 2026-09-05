// Browser-side API client. Talks to the same /api/v1 endpoints as the server
// client (see @lamasync/core/api-client.ts) but uses sessionStorage for the
// API key and the global fetch API. Imports types only from core.

import type {
  ApiKeyCreateResponse,
  ApiKeyRevealResponse,
  ApiKeyRevokeResponse,
  ApiKeySummary,
  ApplicationProtection,
  ApplicationProtectionListItem,
  ApplicationSnapshot,
  ApplicationTemplate,
  AuthMeResponse,
  Backend,
  B2ManagementConfig,
  BrowseResponse,
  Conflict,
  Folder,
  FolderAssignment,
  HealthResponse,
  Host,
  HostClass,
  HostConfig,
  NotificationChannel,
  NotificationEvent,
  LockInfo,
  OperationLog,
  QueuedAction,
  ResticRestoreJob,
  QueuedActionType,
  ResticSnapshot,
  ReleaseInfo,
  ServerDeployConfig,
  Share,
  ServerDeployJob,
  StorageReport,
  FolderSize,
  BrowseRef,
  BrowseJob,
  DemoState,
  DemoSeedSummary,
  FolderSnapshotsResponse,
  PauseMode,
  PauseState,
  PairingSessionCreateResponse,
  PairingSessionStatusResponse,
} from "@lamasync/core";

/** Wire shape of `GET /api/v1/pause` (LAMA-273). */
export interface PauseOverview {
  global: PauseState | null;
  hosts: PauseState[];
}

/** Request body shared by the global and per-device pause endpoints. */
export interface PauseRequest {
  /** ISO timestamp or epoch ms the window ends at. */
  until: string | number;
  mode: PauseMode;
  /** Single-segment rclone size; honored only when mode === "slow". */
  bwlimit?: string | null;
}

// LAMA-266: backup-health wire shapes. `checkedAt` is an ISO string from the
// server. `detail` is a scrubbed failure summary — never raw stderr/secrets.

/** Result of POST /backends/:id/prove (200 ok | 502 not-ok). */
export interface ProveResult {
  ok: boolean;
  /** Restored relative path; present on success. */
  file?: string | null;
  checkedAt: string;
  durationMs: number;
  detail?: string | null;
}

/** Result of POST /backends/:id/drill (201 ok | 502 not-ok). */
export interface DrillResult extends ProveResult {
  summary?: string | null;
  drillId: string;
  livenessOk?: boolean | null;
  backendId: string;
  backendName: string;
  kind: "prove" | "drill";
}

/** One row of GET /health/drills history (newest first). */
export interface HealthDrill {
  id: string;
  backendId: string;
  backendName: string;
  kind: "prove" | "drill";
  ranAt: string;
  ok: boolean;
  detail?: string | null;
}

/** Response of GET /health/drills?limit=N. */
export interface DrillHistory {
  drills: HealthDrill[];
}

const API_KEY_STORAGE = "lamasync_api_key";
const API_KEY_PERSIST_STORAGE = "lamasync_api_key_persist";

// UX workstream 4: "remember me" moves the key to localStorage (survives
// tab/browser restarts); otherwise it lives in sessionStorage only. Reading
// prefers the session copy so an explicit non-remembered login wins over a
// stale remembered key.
export function getApiKey(): string | null {
  const session = sessionStorage.getItem(API_KEY_STORAGE);
  if (session && session.length > 0) return session;
  const persisted = localStorage.getItem(API_KEY_PERSIST_STORAGE);
  return persisted && persisted.length > 0 ? persisted : null;
}

export function setApiKey(key: string, persist = false): void {
  if (key.length === 0) {
    sessionStorage.removeItem(API_KEY_STORAGE);
    localStorage.removeItem(API_KEY_PERSIST_STORAGE);
    return;
  }
  if (persist) {
    localStorage.setItem(API_KEY_PERSIST_STORAGE, key);
    sessionStorage.removeItem(API_KEY_STORAGE);
  } else {
    sessionStorage.setItem(API_KEY_STORAGE, key);
    localStorage.removeItem(API_KEY_PERSIST_STORAGE);
  }
}

export function clearApiKey(): void {
  sessionStorage.removeItem(API_KEY_STORAGE);
  localStorage.removeItem(API_KEY_PERSIST_STORAGE);
}

/** Fired on `window` when the server rejects the stored API key. */
export const UNAUTHORIZED_EVENT = "lamasync:unauthorized";

/**
 * Clear the stored key and notify the app that the session is no longer
 * valid. Called on HTTP 401 responses and on WS auth failures so the UI
 * drops back to the login screen instead of showing dead errors.
 */
export function notifyUnauthorized(): void {
  clearApiKey();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}

class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    // UX workstream 4: server errors use the `{ error }` envelope — prefer
    // it over the raw body so every page's `err.message` renders the clean
    // message without per-page parsing. Non-JSON bodies keep the full text.
    super(extractEnvelopeError(body) ?? `API error ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

/** Pull the `error` field out of a server `{ error: string }` envelope. */
function extractEnvelopeError(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const error = (parsed as Record<string, unknown>).error;
      if (typeof error === "string" && error.length > 0) return error;
    }
  } catch {
    // not JSON — fall through
  }
  return null;
}

/**
 * Shared error-to-string for UI catch sites. ApiError renders the server's
 * `{ error }` envelope (already baked into `message` by the constructor);
 * anything else falls back to `Error.message`.
 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const key = getApiKey();
  if (!key) {
    notifyUnauthorized();
    throw new ApiError(401, "missing api key");
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const url = path.startsWith("/api/v1/")
    ? path
    : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      notifyUnauthorized();
    }
    throw new ApiError(res.status, text);
  }
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "GET" });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PUT",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "PATCH",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T = void>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

/**
 * Fetch a binary response (e.g. an app-snapshot tarball) with the auth header.
 * A plain `<a href>` would not send `Authorization`, so callers that want
 * to offer a download must fetch the bytes and trigger a save via an
 * object URL.
 */
async function apiBlob(path: string): Promise<Blob> {
  const key = getApiKey();
  if (!key) {
    notifyUnauthorized();
    throw new ApiError(401, "missing api key");
  }
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${key}`);
  const url = path.startsWith("/api/v1/")
    ? path
    : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401) {
      notifyUnauthorized();
    }
    throw new ApiError(res.status, text);
  }
  return res.blob();
}

/**
 * Shared LAMA-260 / browse-download helper: POST /browse/download and decode
 * the base64 payload into a Blob. Reused by the Download action (which
 * triggers a save) and the Preview action (which renders the bytes).
 */
async function browseDownloadBlob(ref: BrowseRef, name: string): Promise<Blob> {
  const data = await apiPost<{ name: string; content: string }>(
    "/browse/download",
    { ref, name },
  );
  const binary = atob(data.content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

// Typed domain helpers.

export const api = {
  authMe: () => apiGet<AuthMeResponse>("/auth/me"),
  listApiKeys: () => apiGet<ApiKeySummary[]>("/api-keys"),
  createApiKey: (name: string) =>
    apiPost<ApiKeyCreateResponse>("/api-keys", { name }),
  revealApiKey: (id: string) =>
    apiPost<ApiKeyRevealResponse>(`/api-keys/${encodeURIComponent(id)}/reveal`),
  revokeApiKey: (id: string, reason?: string) =>
    apiPost<ApiKeyRevokeResponse>(`/api-keys/${encodeURIComponent(id)}/revoke`, {
      reason: reason ?? undefined,
    }),
  health: () => apiGet<HealthResponse>("/health"),
  latestRelease: () => apiGet<ReleaseInfo>("/release/latest"),
  // LAMA-301: server-deploy control (Admin page).
  serverDeployConfig: () => apiGet<ServerDeployConfig>("/server-deploys/config"),
  listServerDeploys: (limit?: number) =>
    apiGet<ServerDeployJob[]>(
      limit ? `/server-deploys?limit=${limit}` : "/server-deploys",
    ),
  getServerDeploy: (id: string) =>
    apiGet<ServerDeployJob>(`/server-deploys/${encodeURIComponent(id)}`),
  requestServerDeploy: () =>
    apiPost<ServerDeployJob>("/server-deploys", {}),
  listHosts: () => apiGet<Host[]>("/hosts"),
  getHost: (hostId: string) =>
    apiGet<Host>(`/hosts/${encodeURIComponent(hostId)}`),
  patchHost: (hostId: string, body: { hostname: string }) =>
    apiPatch<Host>(`/hosts/${encodeURIComponent(hostId)}`, body),
  // LAMA-298: override a host's daemon-detected class.
  updateHostClass: (hostId: string, hostClass: HostClass) =>
    apiPatch<Host>(`/hosts/${encodeURIComponent(hostId)}/class`, { hostClass }),
  deleteHost: (hostId: string) =>
    apiDelete(`/hosts/${encodeURIComponent(hostId)}`),
  getConfig: (hostId: string) =>
    apiGet<HostConfig>(`/config/${encodeURIComponent(hostId)}`),
  listFolders: () => apiGet<Folder[]>("/folders"),
  listAssignments: (folderId: string) =>
    apiGet<FolderAssignment[]>(`/folders/${encodeURIComponent(folderId)}/assignments`),
  createFolder: (body: Partial<Folder>) => apiPost<Folder>("/folders", body),
  updateFolder: (id: string, body: Partial<Folder>) =>
    apiPut<Folder>(`/folders/${encodeURIComponent(id)}`, body),
  deleteFolder: (id: string) => apiDelete(`/folders/${encodeURIComponent(id)}`),
  assignFolder: (
    folderId: string,
    body: {
      hostId: string;
      role: string;
      localPath: string;
      syncExpr?: string | null;
      destination?: string | null;
      // LAMA-239: per-host mount/sync override (omit for "inherit").
      mode?: "inherit" | "sync" | "mount" | null;
    },
  ) =>
    apiPost<FolderAssignment>(
      `/folders/${encodeURIComponent(folderId)}/assign`,
      body,
    ),
  unassignFolder: (folderId: string, hostId: string) =>
    apiDelete(
      `/folders/${encodeURIComponent(folderId)}/assign/${encodeURIComponent(hostId)}`,
    ),
  // Fields verified against `PATCH /folders/:id/assign/:hostId`
  // (packages/server/src/routes/folders.ts). role/localPath/
  // bandwidthSchedule are accepted since the hidden-api-power pass;
  // cacheProfile is one of normal/media/minimal.
  // LAMA-239: per-host mount/sync override (`mode`) round-trips through
  // the same endpoint — null on the wire resets to "inherit".
  updateAssignment: (
    folderId: string,
    hostId: string,
    body: Partial<{
      enabled: boolean;
      syncExpr: string | null;
      mode: "inherit" | "sync" | "mount" | null;
      conflictStrategy: string | null;
      timeoutSec: number | null;
      maxRetries: number | null;
      availableSpaceThreshold: number | null;
      preSyncCmd: string | null;
      postSyncCmd: string | null;
      cacheProfile: string | null;
      cacheMaxSize: string | null;
      role: string | null;
      localPath: string | null;
      bandwidthSchedule: string | null;
      destination: string | null;
    }>,
  ) =>
    apiPatch<FolderAssignment>(
      `/folders/${encodeURIComponent(folderId)}/assign/${encodeURIComponent(hostId)}`,
      body,
    ),
  // LAMA-316: application templates — reusable capture recipes owned by the
  // operator. A template never reaches a device by itself; enrolling it on a
  // host creates a protection.
  listAppTemplates: () => apiGet<ApplicationTemplate[]>("/apps/templates"),
  getAppTemplate: (id: string) =>
    apiGet<ApplicationTemplate>(`/apps/templates/${encodeURIComponent(id)}`),
  createAppTemplate: (
    body: Omit<
      ApplicationTemplate,
      "id" | "origin" | "revision" | "createdAt" | "updatedAt"
    >,
  ) => apiPost<ApplicationTemplate>("/apps/templates", body),
  updateAppTemplate: (
    id: string,
    body: Partial<
      Omit<ApplicationTemplate, "id" | "origin" | "revision" | "createdAt" | "updatedAt">
    >,
  ) => apiPut<ApplicationTemplate>(`/apps/templates/${encodeURIComponent(id)}`, body),
  deleteAppTemplate: (id: string) =>
    apiDelete(`/apps/templates/${encodeURIComponent(id)}`),
  // LAMA-316: protections bind one template to one host (enrollment copies the
  // template's capture spec; later template edits never mutate protections).
  listAppProtections: (hostId?: string) =>
    apiGet<ApplicationProtectionListItem[]>(
      hostId
        ? `/apps/protections?hostId=${encodeURIComponent(hostId)}`
        : "/apps/protections",
    ),
  getAppProtection: (id: string) =>
    apiGet<ApplicationProtection>(`/apps/protections/${encodeURIComponent(id)}`),
  enrollAppProtection: (body: {
    templateId: string;
    hostId: string;
    schedule?: string | null;
    name?: string;
  }) => apiPost<ApplicationProtection>("/apps/protections", body),
  updateAppProtection: (
    id: string,
    body: Partial<
      Pick<ApplicationProtection, "name" | "enabled" | "schedule" | "destination">
    >,
  ) => apiPut<ApplicationProtection>(`/apps/protections/${encodeURIComponent(id)}`, body),
  deleteAppProtection: (id: string) =>
    apiDelete(`/apps/protections/${encodeURIComponent(id)}`),
  // LAMA-316: immutable snapshots captured per protection (never created
  // implicitly — the server rejects unknown protections and disabled ones).
  listAppSnapshots: (protectionId: string) =>
    apiGet<ApplicationSnapshot[]>(
      `/apps/protections/${encodeURIComponent(protectionId)}/snapshots`,
    ),
  uploadAppSnapshot: async (
    protectionId: string,
    file: Blob,
    opts: { description?: string } = {},
  ) => {
    const key = getApiKey();
    if (!key) {
      notifyUnauthorized();
      throw new ApiError(401, "missing api key");
    }
    const form = new FormData();
    // The file may come from another realm (drag-drop), so `instanceof` is
    // unreliable — a checked property probe keeps the label without an
    // unchecked cast.
    const filename =
      "name" in file && typeof file.name === "string" && file.name.length > 0
        ? file.name
        : "snapshot.tar.gz";
    form.append("tarball", file, filename);
    if (opts.description) form.append("description", opts.description);
    const res = await fetch(
      `/api/v1/apps/protections/${encodeURIComponent(protectionId)}/snapshots`,
      { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) notifyUnauthorized();
      throw new ApiError(res.status, text);
    }
    return (await res.json()) as ApplicationSnapshot;
  },
  getAppSnapshot: (id: string) =>
    apiGet<ApplicationSnapshot>(`/apps/snapshots/${encodeURIComponent(id)}`),
  deleteAppSnapshot: (id: string) =>
    apiDelete(`/apps/snapshots/${encodeURIComponent(id)}`),
  downloadAppSnapshot: async (id: string) => {
    const blob = await apiBlob(
      `/apps/snapshots/${encodeURIComponent(id)}/download`,
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `app-snapshot-${id.slice(0, 8)}.tar.gz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  listOperations: (opts: {
    limit?: number;
    offset?: number;
    status?: string;
    hostId?: string;
    folderId?: string;
  } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts.status) qs.set("status", opts.status);
    if (opts.hostId) qs.set("hostId", opts.hostId);
    if (opts.folderId) qs.set("folderId", opts.folderId);
    return apiGet<OperationLog[]>(`/operations?${qs.toString()}`);
  },
  listOperationsForHost: (hostId: string, limit = 50) =>
    apiGet<OperationLog[]>(
      `/operations?hostId=${encodeURIComponent(hostId)}&limit=${limit}`,
    ),
  listLocks: () => apiGet<LockInfo[]>("/operations/locks"),
  listConflicts: (status = "pending") =>
    apiGet<Conflict[]>(`/conflicts?status=${encodeURIComponent(status)}`),
  resolveConflict: (id: string, resolution: "local" | "remote" | "both") =>
    apiPost<Conflict>(`/conflicts/${encodeURIComponent(id)}/resolve`, { resolution }),
  // LAMA-202: read-only Data Browser.
  browseLocal: (path?: string) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : "";
    return apiGet<BrowseResponse>(`/browse/local${qs}`);
  },
  browseS3: (folderId: string, path?: string) => {
    const base = `?folderId=${encodeURIComponent(folderId)}`;
    const qs = path ? `${base}&path=${encodeURIComponent(path)}` : base;
    return apiGet<BrowseResponse>(`/browse/s3${qs}`);
  },
  browseRestic: () => apiGet<ResticSnapshot[]>("/browse/restic"),
  // LAMA-259: time-travel browser — folder-scoped backup history and per-
  // snapshot file listings. Additive GETs over the existing browse surface:
  // /snapshots returns an empty list for non-restic folders (so the UI hides
  // the scrubber); /files 404s unknown (folder, snapshot) tuples and 409s
  // non-restic folders (server route: packages/server/src/routes/snapshots.ts).
  listFolderSnapshots: (folderId: string) =>
    apiGet<FolderSnapshotsResponse>(
      `/folders/${encodeURIComponent(folderId)}/snapshots`,
    ),
  listSnapshotFiles: (
    folderId: string,
    snapshotId: string,
    path?: string,
    limit?: number,
  ) => {
    const qs = new URLSearchParams();
    if (path !== undefined && path.length > 0) qs.set("path", path);
    if (limit !== undefined) qs.set("limit", String(limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
    return apiGet<BrowseResponse>(
      `/folders/${encodeURIComponent(folderId)}/snapshots/${encodeURIComponent(snapshotId)}/files${suffix}`,
    );
  },
  // UX workstream 4: restic restore jobs (server routes already exist).
  listResticRestoreJobs: () => apiGet<ResticRestoreJob[]>("/restic/restore"),
  createResticRestore: (opts: {
    snapshotId: string;
    folderId: string;
    targetHostId: string;
    targetPath: string;
    include?: string[];
  }) => apiPost<ResticRestoreJob>("/restic/restore", opts),
  // LAMA-226: Data Browser write operations.
  browseCopy: (source: BrowseRef, destination: BrowseRef, names: string[]) =>
    apiPost<BrowseJob>("/browse/copy", { source, destination, names }),
  browseMove: (source: BrowseRef, destination: BrowseRef, names: string[]) =>
    apiPost<BrowseJob>("/browse/move", { source, destination, names }),
  browseDelete: (ref: BrowseRef, names: string[]) =>
    apiPost<BrowseJob>("/browse/delete", { ref, names }),
  browseDownload: async (ref: BrowseRef, name: string) => {
    const blob = await browseDownloadBlob(ref, name);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  // LAMA-260: fetch a file's bytes for preview via the same /browse/download
  // auth+flow the Download action uses. The server returns base64 content,
  // so we decode it into a Blob the caller can turn into a preview.
  browsePreviewBlob: (ref: BrowseRef, name: string) => browseDownloadBlob(ref, name),
  browseRename: (ref: BrowseRef, from: string, to: string) =>
    apiPost<BrowseJob>("/browse/rename", { ref, from, to }),
  browseMkdir: (ref: BrowseRef, name: string) =>
    apiPost<BrowseJob>("/browse/mkdir", { ref, name }),
  browseUpload: (destination: BrowseRef, name: string, content: string) =>
    apiPost<BrowseJob>("/browse/upload", { destination, name, content }),
  // LAMA-260: multipart upload into a folder's destination backend
  // (POST /folders/:id/files). Synchronous — no job to poll. Uses the raw
  // fetch (not apiFetch) so the browser sets the multipart boundary instead
  // of a forced JSON content-type.
  uploadFolderFile: async (
    folderId: string,
    file: Blob,
    opts: { path?: string } = {},
  ) => {
    const key = getApiKey();
    if (!key) {
      notifyUnauthorized();
      throw new ApiError(401, "missing api key");
    }
    const form = new FormData();
    const filename = (file as { name?: unknown }).name;
    form.append(
      "file",
      file,
      typeof filename === "string" && filename.length > 0 ? filename : "upload.bin",
    );
    if (opts.path) form.append("path", opts.path);
    const res = await fetch(
      `/api/v1/folders/${encodeURIComponent(folderId)}/files`,
      { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) notifyUnauthorized();
      throw new ApiError(res.status, text);
    }
    return (await res.json()) as { ok: boolean; name: string; path: string; size: number };
  },
  listBrowseJobs: (limit = 50) =>
    apiGet<BrowseJob[]>(`/browse/jobs?limit=${limit}`),
  // LAMA-222: reusable backends. Secrets are write-only (hasSecret flags
  // presence); the test endpoint surfaces rclone's error detail.
  listBackends: () => apiGet<Backend[]>("/backends"),
  createBackend: (body: Partial<Backend>) =>
    apiPost<Backend>("/backends", body),
  updateBackend: (id: string, body: Partial<Backend>) =>
    apiPatch<Backend>(`/backends/${encodeURIComponent(id)}`, body),
  deleteBackend: (id: string) =>
    apiDelete(`/backends/${encodeURIComponent(id)}`),
  testBackend: (id: string) =>
    apiPost<{ ok: boolean; detail?: string }>(`/backends/${encodeURIComponent(id)}/test`),
  createB2Bucket: (name: string) =>
    apiPost<{ ok: boolean; detail?: string }>("/backends/b2-buckets", { name }),
  getB2Management: () => apiGet<B2ManagementConfig | null>("/admin/b2-management"),
  saveB2Management: (body: {
    endpoint: string;
    region: string;
    applicationKeyId: string;
    applicationKey?: string;
  }) => apiPut<B2ManagementConfig>("/admin/b2-management", body),
  testB2Management: () =>
    apiPost<{ ok: boolean; detail?: string }>("/admin/b2-management/test"),
  // LAMA-266: backup health — "Prove it" restore tests, fire drills, and the
  // drill history feed. Both mutating calls refresh backends after success so
  // lastProveAt/lastProveOk stay current for the Dashboard badge.
  proveBackend: (id: string) =>
    apiPost<ProveResult>(`/backends/${encodeURIComponent(id)}/prove`),
  runDrill: (id: string) =>
    apiPost<DrillResult>(`/backends/${encodeURIComponent(id)}/drill`),
  listHealthDrills: (limit = 10) =>
    apiGet<DrillHistory>(`/health/drills?limit=${limit}`),
  // LAMA-238: connection test for an unsaved backend config (create/edit
  // form). Write-only fields fall back to the stored values server-side
  // when backendId references an existing backend.
  testBackendDraft: (body: {
    kind?: string;
    backendId?: string;
    s3Provider?: string;
    s3Endpoint?: string;
    s3Region?: string;
    s3AccessKeyId?: string;
    s3SecretAccessKey?: string;
    localPath?: string;
    resticRepository?: string;
    resticPassword?: string;
  }) => apiPost<{ ok: boolean; detail?: string }>("/backends/test", body),
  // LAMA-224: storage statistics.
  storageReport: (refresh = false) =>
    apiGet<StorageReport>(`/stats/storage${refresh ? "?refresh=1" : ""}`),
  // LAMA-269: bulk last-known working-set sizes for the storage donut.
  folderSizes: () =>
    apiGet<Record<string, FolderSize>>("/folders/sizes"),
  // LAMA-269: per-backend size time series for the growth sparkline.
  storageHistory: () =>
    apiGet<{
      backends: Record<string, Array<{ measuredAt: number; bytes: number | null }>>;
    }>("/stats/storage/history"),
  folderSize: (id: string) =>
    apiGet<FolderSize>(`/folders/${encodeURIComponent(id)}/size`),
  listShares: () => apiGet<Share[]>("/shares"),
  listResticSnapshots: () => apiGet<ResticSnapshot[]>("/restic/snapshots"),
  pruneOperations: (olderThanMs: number) =>
    apiPost<{ deleted: number; olderThanMs: number }>(
      `/admin/prune?olderThanMs=${olderThanMs}`,
    ),
  listNotifications: (limit = 20) =>
    apiGet<NotificationEvent[]>(`/notifications?limit=${limit}`),
  sendTestNotification: () =>
    apiPost<NotificationEvent>("/notifications/test"),
  // LAMA-221: configurable notification channels.
  listNotificationChannels: () =>
    apiGet<NotificationChannel[]>("/notifications/channels"),
  createNotificationChannel: (body: {
    kind: "ntfy" | "webhook";
    name: string;
    url: string;
    enabled?: boolean;
    severities: NotificationChannel["severities"];
  }) => apiPost<NotificationChannel>("/notifications/channels", body),
  updateNotificationChannel: (
    id: string,
    body: Partial<{
      kind: "ntfy" | "webhook";
      name: string;
      url: string;
      enabled: boolean;
      severities: NotificationChannel["severities"];
    }>,
  ) =>
    // LAMA-221: the server registers `PATCH /notifications/channels/:id`
    // (not PUT). Edit/Save, severity toggle, and enable toggle on the
    // Admin page all 404'd with `apiPut`; `apiPatch` matches the route.
    apiPatch<NotificationChannel>(
      `/notifications/channels/${encodeURIComponent(id)}`,
      body,
    ),
  deleteNotificationChannel: (id: string) =>
    apiDelete(`/notifications/channels/${encodeURIComponent(id)}`),
  testNotificationChannel: (channelId: string) =>
    apiPost<{ channelId: string; delivered: boolean; status: "success" | "failed" }>(
      "/notifications/test",
      { channelId },
    ),
  // LAMA-264: demo mode. Read state, seed a demo fleet, or delete all demo
  // data (the Delete action is confirmed in the UI before calling this).
  getDemo: () => apiGet<DemoState>("/demo"),
  seedDemo: () => apiPost<DemoSeedSummary>("/demo/seed"),
  deleteDemo: () => apiDelete<DemoSeedSummary>("/demo"),
  // LAMA-198: queued-action model. The Web UI uses `enqueueAction` to ask
  // a daemon to do work (sync, backup, check-update, refresh-config); the
  // rest of the endpoints exist for the detail page to render recent
  // action history.
  enqueueAction: (
    hostId: string,
    body: { type: QueuedActionType; payload?: Record<string, unknown> | null },
  ): Promise<QueuedAction> =>
    apiPost<QueuedAction>(
      `/hosts/${encodeURIComponent(hostId)}/actions`,
      body,
    ),
  listHostActions: (hostId: string, status?: string) =>
    apiGet<QueuedAction[]>(
      status
        ? `/hosts/${encodeURIComponent(hostId)}/actions?status=${encodeURIComponent(status)}`
        : `/hosts/${encodeURIComponent(hostId)}/actions`,
    ),
  // LAMA-273: pause / slow mode. Global + per-device set/clear; GET returns
  // the current global row plus every per-device row so the UI can render a
  // countdown banner and control for the current context.
  getPause: () => apiGet<PauseOverview>("/pause"),
  setPause: (body: PauseRequest) => apiPost<PauseState>("/pause", body),
  clearPause: () => apiDelete<void>("/pause"),
  setHostPause: (hostId: string, body: PauseRequest) =>
    apiPost<PauseState>(`/hosts/${encodeURIComponent(hostId)}/pause`, body),
  clearHostPause: (hostId: string) =>
    apiDelete<void>(`/hosts/${encodeURIComponent(hostId)}/pause`),
  // LAMA-262: pairing sessions. `createPairingSession` issues a fresh short
  // code (admin-only); `lookupPairingSession` polls status + expiry so the UI
  // can flip to a "claimed" state when a device exchanges the code. The
  // exchange itself is intentionally NOT exposed here — it's the no-auth
  // endpoint the CLI calls, and the browser operator never needs the key.
  createPairingSession: (opts: { ttlSeconds?: number } = {}) =>
    apiPost<PairingSessionCreateResponse>("/pairing", opts),
  lookupPairingSession: (code: string) =>
    apiGet<PairingSessionStatusResponse>(
      `/pairing/${encodeURIComponent(code)}`,
    ),
};

export { ApiError };
