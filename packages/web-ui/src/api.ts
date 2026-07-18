// Browser-side API client. Talks to the same /api/v1 endpoints as the server
// client (see @lamasync/core/api-client.ts) but uses sessionStorage for the
// API key and the global fetch API. Imports types only from core.

import type {
  Conflict,
  DotfileManifest,
  Folder,
  FolderAssignment,
  HealthResponse,
  Host,
  OperationLog,
  ResticSnapshot,
  Share,
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

export function apiDelete<T = void>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

// Typed domain helpers.

export const api = {
  health: () => apiGet<HealthResponse>("/health"),
  listFolders: () => apiGet<Folder[]>("/folders"),
  listAssignments: (folderId: string) =>
    apiGet<FolderAssignment[]>(`/folders/${encodeURIComponent(folderId)}/assignments`),
  createFolder: (body: Partial<Folder>) => apiPost<Folder>("/folders", body),
  updateFolder: (id: string, body: Partial<Folder>) =>
    apiPut<Folder>(`/folders/${encodeURIComponent(id)}`, body),
  deleteFolder: (id: string) => apiDelete(`/folders/${encodeURIComponent(id)}`),
  listManifests: () => apiGet<DotfileManifest[]>("/dotfiles/manifests"),
  createManifest: (body: Partial<DotfileManifest>) =>
    apiPost<DotfileManifest>("/dotfiles/manifests", body),
  updateManifest: (id: string, body: Partial<DotfileManifest>) =>
    apiPut<DotfileManifest>(`/dotfiles/manifests/${encodeURIComponent(id)}`, body),
  deleteManifest: (id: string) =>
    apiDelete(`/dotfiles/manifests/${encodeURIComponent(id)}`),
  listOperations: (limit = 20) =>
    apiGet<OperationLog[]>(`/operations?limit=${limit}`),
  listConflicts: (status = "pending") =>
    apiGet<Conflict[]>(`/conflicts?status=${encodeURIComponent(status)}`),
  resolveConflict: (id: string, resolution: "local" | "remote" | "both") =>
    apiPost<Conflict>(`/conflicts/${encodeURIComponent(id)}/resolve`, { resolution }),
  listShares: () => apiGet<Share[]>("/shares"),
  listResticSnapshots: () => apiGet<ResticSnapshot[]>("/restic/snapshots"),
  pruneOperations: (olderThanMs: number) =>
    apiPost<{ deleted: number; olderThanMs: number }>(
      `/admin/prune?olderThanMs=${olderThanMs}`,
    ),
};

export { ApiError };
