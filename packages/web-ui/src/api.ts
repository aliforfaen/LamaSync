// Browser-side API client. Talks to the same /api/v1 endpoints as the server
// client (see @lamasync/core/api-client.ts) but uses sessionStorage for the
// API key and the global fetch API. Imports types only from core.

import type {
  Backend,
  BrowseResponse,
  Conflict,
  DotfileManifest,
  Folder,
  FolderAssignment,
  HealthResponse,
  Host,
  HostConfig,
  NotificationChannel,
  NotificationEvent,
  OperationLog,
  QueuedAction,
  QueuedActionType,
  ResticSnapshot,
  Share,
  StorageReport,
  FolderSize,
  BrowseRef,
  BrowseJob,
} from "@lamasync/core";

const API_KEY_STORAGE = "lamasync_api_key";

export function getApiKey(): string | null {
  const v = sessionStorage.getItem(API_KEY_STORAGE);
  return v && v.length > 0 ? v : null;
}

export function setApiKey(key: string): void {
  if (key.length === 0) {
    sessionStorage.removeItem(API_KEY_STORAGE);
    return;
  }
  sessionStorage.setItem(API_KEY_STORAGE, key);
}

export function clearApiKey(): void {
  sessionStorage.removeItem(API_KEY_STORAGE);
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
    super(`API error ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
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

// Typed domain helpers.

export const api = {
  health: () => apiGet<HealthResponse>("/health"),
  listHosts: () => apiGet<Host[]>("/hosts"),
  getHost: (hostId: string) =>
    apiGet<Host>(`/hosts/${encodeURIComponent(hostId)}`),
  patchHost: (hostId: string, body: { hostname: string }) =>
    apiPatch<Host>(`/hosts/${encodeURIComponent(hostId)}`, body),
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
  listManifests: (hostId?: string) =>
    apiGet<DotfileManifest[]>(
      hostId
        ? `/dotfiles/manifests?hostId=${encodeURIComponent(hostId)}`
        : "/dotfiles/manifests",
    ),
  createManifest: (body: Partial<DotfileManifest>) =>
    apiPost<DotfileManifest>("/dotfiles/manifests", body),
  updateManifest: (id: string, body: Partial<DotfileManifest>) =>
    apiPut<DotfileManifest>(`/dotfiles/manifests/${encodeURIComponent(id)}`, body),
  deleteManifest: (id: string) =>
    apiDelete(`/dotfiles/manifests/${encodeURIComponent(id)}`),
  listOperations: (limit = 20) =>
    apiGet<OperationLog[]>(`/operations?limit=${limit}`),
  listOperationsForHost: (hostId: string, limit = 50) =>
    apiGet<OperationLog[]>(
      `/operations?hostId=${encodeURIComponent(hostId)}&limit=${limit}`,
    ),
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
  // LAMA-226: Data Browser write operations.
  browseCopy: (source: BrowseRef, destination: BrowseRef, names: string[]) =>
    apiPost<BrowseJob>("/browse/copy", { source, destination, names }),
  browseMove: (source: BrowseRef, destination: BrowseRef, names: string[]) =>
    apiPost<BrowseJob>("/browse/move", { source, destination, names }),
  browseRename: (ref: BrowseRef, from: string, to: string) =>
    apiPost<BrowseJob>("/browse/rename", { ref, from, to }),
  browseMkdir: (ref: BrowseRef, name: string) =>
    apiPost<BrowseJob>("/browse/mkdir", { ref, name }),
  browseUpload: (destination: BrowseRef, name: string, content: string) =>
    apiPost<BrowseJob>("/browse/upload", { destination, name, content }),
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
  // LAMA-224: storage statistics.
  storageReport: (refresh = false) =>
    apiGet<StorageReport>(`/stats/storage${refresh ? "?refresh=1" : ""}`),
  folderSize: (id: string, refresh = false) =>
    apiGet<FolderSize>(`/folders/${encodeURIComponent(id)}/size${refresh ? "?refresh=1" : ""}`),
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
};

export { ApiError };
