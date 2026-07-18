import type {
  Conflict,
  ConflictResolution,
  DotfileManifest,
  DotfileVersion,
  Folder,
  FolderAssignment,
  HealthReport,
  HealthResponse,
  Host,
  HostConfig,
  OperationLog,
  OperationReport,
  ResticRestoreJob,
  ResticSnapshot,
  Share,
} from "./types.ts";

export class LamaSyncApiError extends Error {
  status: number;
  body: string;
  code?: string;
  constructor(status: number, body: string, message?: string) {
    let code: string | undefined;
    if (message === undefined) {
      try {
        const parsed = JSON.parse(body);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof parsed.error === "string"
        ) {
          code = parsed.error;
        }
      } catch {
        // body is not JSON; leave code undefined.
      }
    }
    super(
      message ??
        (code
          ? `LamaSync API error ${status}: ${code}`
          : `LamaSync API error ${status}: ${body}`),
    );
    this.name = "LamaSyncApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export interface LamaSyncApiClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
}

export class LamaSyncApiClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(baseUrl: string, apiKey: string, opts: LamaSyncApiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  private isRetriableError(error: unknown): boolean {
    return (
      error instanceof TypeError ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: BodyInit | null,
    contentType?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (contentType) headers["Content-Type"] = contentType;

    const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body ?? null,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          if (idempotent && res.status >= 500 && res.status < 600 && attempt < this.maxRetries) {
            lastError = new LamaSyncApiError(res.status, text);
            await this.delay(1_000 * 2 ** attempt);
            continue;
          }
          throw new LamaSyncApiError(res.status, text);
        }
        if (res.status === 204) return undefined as unknown as T;
        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          return (await res.json()) as T;
        }
        return (await res.text()) as unknown as T;
      } catch (error) {
        if (idempotent && attempt < this.maxRetries && this.isRetriableError(error)) {
          lastError = error;
          await this.delay(1_000 * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error("request retries exhausted");
  }

  // Health & config
  getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/api/v1/health");
  }

  registerHost(host: {
    id: string;
    hostname: string;
    tailnetIp?: string | null;
  }): Promise<Host> {
    return this.request<Host>(
      "POST",
      "/api/v1/register",
      JSON.stringify(host),
      "application/json",
    );
  }

  getConfig(hostId: string): Promise<HostConfig> {
    return this.request<HostConfig>("GET", `/api/v1/config/${encodeURIComponent(hostId)}`);
  }

  reportHealth(body: HealthReport): Promise<void> {
    return this.request<void>(
      "POST",
      "/api/v1/report/health",
      JSON.stringify(body),
      "application/json",
    );
  }

  reportOperation(body: OperationReport): Promise<void> {
    return this.request<void>(
      "POST",
      "/api/v1/report",
      JSON.stringify(body),
      "application/json",
    );
  }

  // Folders
  listFolders(): Promise<Folder[]> {
    return this.request<Folder[]>("GET", "/api/v1/folders");
  }

  createFolder(body: Omit<Folder, "id">): Promise<Folder> {
    return this.request<Folder>(
      "POST",
      "/api/v1/folders",
      JSON.stringify(body),
      "application/json",
    );
  }

  getFolder(id: string): Promise<Folder> {
    return this.request<Folder>("GET", `/api/v1/folders/${encodeURIComponent(id)}`);
  }

  updateFolder(id: string, body: Partial<Folder>): Promise<Folder> {
    return this.request<Folder>(
      "PUT",
      `/api/v1/folders/${encodeURIComponent(id)}`,
      JSON.stringify(body),
      "application/json",
    );
  }

  deleteFolder(id: string): Promise<void> {
    return this.request<void>("DELETE", `/api/v1/folders/${encodeURIComponent(id)}`);
  }

  listFolderAssignments(folderId: string): Promise<FolderAssignment[]> {
    return this.request<FolderAssignment[]>(
      "GET",
      `/api/v1/folders/${encodeURIComponent(folderId)}/assignments`,
    );
  }
  assignFolder(
    id: string,
    body: Omit<FolderAssignment, "id">,
  ): Promise<FolderAssignment> {
    return this.request<FolderAssignment>(
      "POST",
      `/api/v1/folders/${encodeURIComponent(id)}/assign`,
      JSON.stringify(body),
      "application/json",
    );
  }

  unassignFolder(id: string, hostId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/folders/${encodeURIComponent(id)}/assign/${encodeURIComponent(hostId)}`,
    );
  }

  updateAssignment(
    folderId: string,
    hostId: string,
    body: Partial<FolderAssignment>,
  ): Promise<FolderAssignment> {
    return this.request<FolderAssignment>(
      "PATCH",
      `/api/v1/folders/${encodeURIComponent(folderId)}/assign/${encodeURIComponent(hostId)}`,
      JSON.stringify(body),
      "application/json",
    );
  }

  // Dotfiles
  listDotfileManifests(hostId?: string): Promise<DotfileManifest[]> {
    const qs = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
    return this.request<DotfileManifest[]>("GET", `/api/v1/dotfiles/manifests${qs}`);
  }

  createDotfileManifest(body: Omit<DotfileManifest, "id">): Promise<DotfileManifest> {
    return this.request<DotfileManifest>(
      "POST",
      "/api/v1/dotfiles/manifests",
      JSON.stringify(body),
      "application/json",
    );
  }

  updateDotfileManifest(id: string, body: Partial<DotfileManifest>): Promise<DotfileManifest> {
    return this.request<DotfileManifest>(
      "PUT",
      `/api/v1/dotfiles/manifests/${encodeURIComponent(id)}`,
      JSON.stringify(body),
      "application/json",
    );
  }

  deleteDotfileManifest(id: string): Promise<void> {
    return this.request<void>("DELETE", `/api/v1/dotfiles/manifests/${encodeURIComponent(id)}`);
  }

  listDotfileVersions(appName: string): Promise<DotfileVersion[]> {
    return this.request<DotfileVersion[]>(
      "GET",
      `/api/v1/dotfiles/${encodeURIComponent(appName)}`,
    );
  }

  async uploadDotfile(
    appName: string,
    tarball: Blob,
    opts: { description?: string; hostId?: string } = {},
  ): Promise<DotfileVersion> {
    const form = new FormData();
    form.append("tarball", tarball, `${appName}.tar.gz`);
    if (opts.description) form.append("description", opts.description);
    if (opts.hostId) form.append("hostId", opts.hostId);
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/dotfiles/${encodeURIComponent(appName)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LamaSyncApiError(res.status, text);
    }
    return (await res.json()) as DotfileVersion;
  }
  async downloadDotfile(appName: string, version: string): Promise<Blob> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/dotfiles/${encodeURIComponent(appName)}/${encodeURIComponent(version)}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LamaSyncApiError(res.status, text);
    }
    return await res.blob();
  }

  deleteDotfile(appName: string, version: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `/api/v1/dotfiles/${encodeURIComponent(appName)}/${encodeURIComponent(version)}`,
    );
  }

  // Operations
  listOperations(opts: {
    hostId?: string;
    status?: string;
    folderId?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<OperationLog[]> {
    const params = new URLSearchParams();
    if (opts.hostId) params.set("hostId", opts.hostId);
    if (opts.status) params.set("status", opts.status);
    if (opts.folderId) params.set("folderId", opts.folderId);
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    if (typeof opts.offset === "number") params.set("offset", String(opts.offset));
    const qs = params.toString();
    const path = qs ? `/api/v1/operations?${qs}` : "/api/v1/operations";
    return this.request<OperationLog[]>("GET", path);
  }

  // Lock coordination
  async acquireLock(folderId: string, hostId: string): Promise<{ lockId: string; ttl: number; acquired: boolean } | { error: string; lockedBy: string; remainingSec: number }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/operations/acquire`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId, hostId }),
      },
    );
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new LamaSyncApiError(res.status, text);
    return JSON.parse(text);
  }

  async heartbeatLock(folderId: string, hostId: string, lockId?: string): Promise<{ ok: boolean; renewedAt: number }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/operations/heartbeat`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId, hostId, ...(lockId !== undefined ? { lockId } : {}) }),
      },
    );
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new LamaSyncApiError(res.status, text);
    return JSON.parse(text);
  }

  async releaseLock(folderId: string, hostId: string, status: string, summary?: string, lockId?: string): Promise<{ ok: boolean }> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/api/v1/operations/release`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId, hostId, status, ...(summary !== undefined ? { summary } : {}), ...(lockId !== undefined ? { lockId } : {}) }),
      },
    );
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new LamaSyncApiError(res.status, text);
    return JSON.parse(text);
  }


  async listLocks(): Promise<{ folderId: string; lockedBy: string; lockedAt: number; lockTtl: number }[]> {
    return this.request("GET", "/api/v1/operations/locks");
  }

  pruneOperations(olderThanMs: number): Promise<{ deleted: number; olderThanMs: number }> {
    return this.request("POST", `/api/v1/admin/prune?olderThanMs=${olderThanMs}`);
  }

  deleteHost(hostId: string): Promise<void> {
    return this.request<void>("DELETE", `/api/v1/hosts/${encodeURIComponent(hostId)}`);
  }

  listDotfilesForHost(hostId: string): Promise<DotfileVersion[]> {
    return this.request<DotfileVersion[]>(
      "GET",
      `/api/v1/dotfiles?hostId=${encodeURIComponent(hostId)}`,
    );
  }

  // Shares
  listShares(): Promise<Share[]> {
    return this.request<Share[]>("GET", "/api/v1/shares");
  }

  // Restic snapshots
  listResticSnapshots(opts: { folderId?: string; hostId?: string } = {}): Promise<ResticSnapshot[]> {
    const params = new URLSearchParams();
    if (opts.folderId) params.set("folderId", opts.folderId);
    if (opts.hostId) params.set("hostId", opts.hostId);
    const qs = params.toString();
    const path = qs ? `/api/v1/restic/snapshots?${qs}` : "/api/v1/restic/snapshots";
    return this.request<ResticSnapshot[]>("GET", path);
  }

  reportResticSnapshot(snapshot: Omit<ResticSnapshot, "id">): Promise<ResticSnapshot> {
    return this.request<ResticSnapshot>(
      "POST",
      "/api/v1/restic/snapshots",
      JSON.stringify(snapshot),
      "application/json",
    );
  }

  requestResticRestore(
    snapshotId: string,
    folderId: string,
    targetHostId: string,
    targetPath: string,
    include?: string[],
  ): Promise<ResticRestoreJob> {
    return this.request<ResticRestoreJob>(
      "POST",
      "/api/v1/restic/restore",
      JSON.stringify({ snapshotId, folderId, targetHostId, targetPath, include }),
      "application/json",
    );
  }

  listResticRestoreJobs(targetHostId?: string): Promise<ResticRestoreJob[]> {
    const path = targetHostId
      ? `/api/v1/restic/restore?targetHostId=${encodeURIComponent(targetHostId)}`
      : "/api/v1/restic/restore";
    return this.request<ResticRestoreJob[]>("GET", path);
  }

  updateResticRestoreJob(id: string, status: ResticRestoreJob["status"], error?: string | null): Promise<ResticRestoreJob> {
    return this.request<ResticRestoreJob>(
      "POST",
      `/api/v1/restic/restore/${encodeURIComponent(id)}/status`,
      JSON.stringify({ status, error: error ?? null }),
      "application/json",
    );
  }

  // Conflicts
  listConflicts(opts: { hostId?: string; folderId?: string; status?: string } = {}): Promise<Conflict[]> {
    const params = new URLSearchParams();
    if (opts.hostId) params.set("hostId", opts.hostId);
    if (opts.folderId) params.set("folderId", opts.folderId);
    if (opts.status) params.set("status", opts.status);
    const qs = params.toString();
    const path = qs ? `/api/v1/conflicts?${qs}` : "/api/v1/conflicts";
    return this.request<Conflict[]>("GET", path);
  }

  createConflicts(conflicts: Array<Omit<Conflict, "id" | "createdAt" | "status" | "resolvedAt">>): Promise<Conflict[]> {
    return this.request<Conflict[]>(
      "POST",
      "/api/v1/conflicts",
      JSON.stringify({ conflicts }),
      "application/json",
    );
  }

  resolveConflict(id: string, resolution: ConflictResolution): Promise<Conflict> {
    return this.request<Conflict>(
      "POST",
      `/api/v1/conflicts/${encodeURIComponent(id)}/resolve`,
      JSON.stringify({ resolution }),
      "application/json",
    );
  }
}
