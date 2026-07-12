import type {
  DotfileVersion,
  Folder,
  FolderAssignment,
  HealthReport,
  HealthResponse,
  Host,
  HostConfig,
  OperationLog,
  OperationReport,
} from "./types.ts";

export class LamaSyncApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `LamaSync API error ${status}: ${body}`);
    this.name = "LamaSyncApiError";
    this.status = status;
    this.body = body;
  }
}

export interface LamaSyncApiClientOptions {
  fetchImpl?: typeof fetch;
}

export class LamaSyncApiClient {
  readonly baseUrl: string;
  readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, apiKey: string, opts: LamaSyncApiClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
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
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ?? null,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LamaSyncApiError(res.status, text);
    }
    if (res.status === 204) return undefined as unknown as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return (await res.json()) as T;
    }
    return (await res.text()) as unknown as T;
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

  // Dotfiles
  listDotfileVersions(appName: string): Promise<DotfileVersion[]> {
    return this.request<DotfileVersion[]>(
      "GET",
      `/api/v1/dotfiles/${encodeURIComponent(appName)}`,
    );
  }

  async uploadDotfile(
    appName: string,
    tarball: Blob,
    opts: { description?: string } = {},
  ): Promise<DotfileVersion> {
    const form = new FormData();
    form.append("tarball", tarball, `${appName}.tar.gz`);
    if (opts.description) form.append("description", opts.description);
    const res = await this.fetchImpl(
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
    const res = await this.fetchImpl(
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
  } = {}): Promise<OperationLog[]> {
    const params = new URLSearchParams();
    if (opts.hostId) params.set("hostId", opts.hostId);
    if (opts.status) params.set("status", opts.status);
    if (opts.folderId) params.set("folderId", opts.folderId);
    if (typeof opts.limit === "number") params.set("limit", String(opts.limit));
    const qs = params.toString();
    const path = qs ? `/api/v1/operations?${qs}` : "/api/v1/operations";
    return this.request<OperationLog[]>("GET", path);
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
}
