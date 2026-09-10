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
  RetentionEvaluation,
  RetentionPolicy,
  RetentionRule,
  RetentionDecision,
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
  BrowsePrefixSizeResult,
  DemoState,
  DemoSeedSummary,
  FolderSnapshotsResponse,
  MobileClientType,
  MobileEnrollmentCreateRequest,
  MobileEnrollmentCreateResponse,
  MobileEnrollmentStatusResponse,
  MobileRegistrationRevokeResponse,
  MobileRegistrationSummary,
  MobileUploadDestination,
  MobileUploadDestinationCreateRequest,
  MobileUploadDestinationCreateResponse,
  MobileUploadDestinationUpdateRequest,
  MobileUploadDestinationRevokeResponse,
  MobileWebSessionLogoutResponse,
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

// ---------------------------------------------------------------------------
// LAMA-296 — SPA auth modes.
//
// The SPA authenticates in exactly one of two modes:
//   bearer — the classic browser flow: an API key in session/localStorage is
//     sent as `Authorization: Bearer …` on every request, including the
//     WebSocket upgrade (subprotocol token). Unchanged behavior.
//   session — the Android WebView flow: the NATIVE bootstrap route set the
//     host-only `__Host-lamasync-mobile` cookie (Secure/HttpOnly/SameSite,
//     never set by the SPA and never a dummy key in sessionStorage). The SPA
//     discovers the live session through GET /api/v1/auth/me (the dual-mode
//     session-discovery endpoint owned by ServerMobile; wave-2 contract):
//       200 { authenticated:true, mode:"session", kind:"mobile-session",
//             keyId:null, name:<displayName>, hostId, displayName,
//             clientType:"android", expiresAt:<epoch ms>, csrfToken }
//       or for a bearer: { authenticated:true, mode:"bearer", kind, keyId,
//             name, hostId }
//       else 401 { error:"Unauthorized" } — an invalid Authorization header
//       NEVER falls back to the cookie (the server enforces this too).
//   Session-mode requests authenticate via the cookie; cookie-authenticated
//   mutations (POST/PUT/PATCH/DELETE) additionally carry the session-bound
//   CSRF token (X-CSRF-Token), delivered by the authenticated auth metadata.
//   The token lives only in memory — never sessionStorage — and is refreshed
//   on every /auth/me response. Exact trusted-Origin is enforced server-side;
//   the browser sends Origin itself on same-origin mutations and WS upgrades.
// ---------------------------------------------------------------------------

/** Session-mode identity, delivered by the dual-mode /auth/me discovery. */
export interface MobileWebSessionInfo {
  hostId: string;
  displayName: string;
  clientType: MobileClientType;
  /** Epoch-ms absolute session expiry (12 h). */
  expiresAt: number;
  /** Session-bound CSRF token for cookie-authenticated mutations. */
  csrfToken: string;
}

/** /auth/me when the request authenticated as a live mobile session. */
export interface AuthMeSessionResponse extends MobileWebSessionInfo {
  authenticated: true;
  mode: "session";
  kind: "mobile-session";
  keyId: null;
  name: string;
}

/** /auth/me when the request authenticated as a classic bearer principal. */
export type AuthMeBearerResponse = AuthMeResponse & {
  authenticated: true;
  mode: "bearer";
};

/** Full dual-mode /auth/me payload. */
export type AuthMeInfo = AuthMeSessionResponse | AuthMeBearerResponse;

/** In-memory session metadata; never persisted (CSRF lives here only). */
let sessionAuth: MobileWebSessionInfo | null = null;

/** The active session-mode identity, or null in bearer / logged-out states. */
export function getSessionAuth(): MobileWebSessionInfo | null {
  return sessionAuth;
}

export function clearSessionAuth(): void {
  sessionAuth = null;
}

/** Which credential the SPA currently holds. */
export type AuthMode = "bearer" | "session" | "none";

/** Resolve the current auth mode without network I/O. A stored key always
 *  wins over a cookie session: when an Authorization header is present but
 *  invalid the request fails (401) rather than silently falling back to the
 *  cookie — matching the server's dual-mode rule. */
export function getAuthMode(): AuthMode {
  if (getApiKey() !== null) return "bearer";
  return sessionAuth !== null ? "session" : "none";
}

/** Result of the boot-time session probe. */
export type SessionProbeResult =
  | { mode: "session" }
  | { mode: "none"; reachable: boolean };

/** True when `value` is a live-session /auth/me payload with the fields the
 *  SPA needs (hostId, displayName, CSRF token, expiry, android client). */
function isSessionAuthInfo(value: unknown): value is AuthMeSessionResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (rec.authenticated !== true || rec.mode !== "session") return false;
  if (rec.kind !== "mobile-session") return false;
  if (typeof rec.hostId !== "string" || rec.hostId.length === 0) return false;
  if (typeof rec.displayName !== "string" || rec.displayName.length === 0) {
    return false;
  }
  if (typeof rec.name !== "string") return false;
  if (rec.clientType !== "android") return false;
  if (typeof rec.expiresAt !== "number") return false;
  if (typeof rec.csrfToken !== "string" || rec.csrfToken.length === 0) {
    return false;
  }
  return true;
}

/**
 * Boot-time session discovery (no API key in storage): probe
 * GET /api/v1/auth/me with the cookie only and, on a live session response,
 * install the in-memory session identity. Never sends an Authorization
 * header, so a bearer credential cannot mask an invalid session and an
 * invalid session can never be "refreshed" from a cookie silently.
 */
export async function probeSession(): Promise<SessionProbeResult> {
  clearSessionAuth();
  try {
    const res = await fetchWithTransportSignal(apiUrl("/auth/me"), {
      method: "GET",
      headers: {},
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return { mode: "none", reachable: true };
    const parsed: unknown = await res.json().catch(() => null);
    if (!isSessionAuthInfo(parsed)) return { mode: "none", reachable: true };
    sessionAuth = {
      hostId: parsed.hostId,
      displayName: parsed.displayName,
      clientType: parsed.clientType,
      expiresAt: parsed.expiresAt,
      csrfToken: parsed.csrfToken,
    };
    return { mode: "session" };
  } catch {
    return { mode: "none", reachable: false };
  }
}

/**
 * Sign out of a cookie-authenticated web session: POST /web-session/logout
 * (CSRF-protected), which invalidates the session and clears the cookie
 * server-side — the SPA cannot delete an HttpOnly cookie itself, so a local
 * clear alone would log straight back in on reload. Never touches the
 * native registration. Returns "logged-out" once the server confirmed (or
 * the session was already invalid, 401), and "failed" when the session is
 * still live server-side and the caller should stay signed in.
 */
export type SessionLogoutResult = "logged-out" | "already-invalid" | "failed";

export async function sessionLogout(): Promise<SessionLogoutResult> {
  if (getAuthMode() !== "session") {
    clearSessionAuth();
    return "logged-out";
  }
  try {
    await apiPost<MobileWebSessionLogoutResponse>("/mobile/web-session/logout", {});
    clearSessionAuth();
    return "logged-out";
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearSessionAuth();
      return "already-invalid";
    }
    return "failed";
  }
}

/** Fired on `window` when the server rejects the stored credential. */
export const UNAUTHORIZED_EVENT = "lamasync:unauthorized";

/**
 * LAMA-329 phase 7: transport-outcome signals for the connectivity banner.
 *
 * Only a TRANSPORT failure counts. A 4xx/5xx response means the server is
 * reachable and answered, which is a different problem and must not make the
 * UI claim the fleet is unreachable.
 */
export const REQUEST_FAILED_EVENT = "lamasync:request-failed";
export const REQUEST_SUCCEEDED_EVENT = "lamasync:request-succeeded";

export function notifyRequestFailed(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REQUEST_FAILED_EVENT));
}

export function notifyRequestSucceeded(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REQUEST_SUCCEEDED_EVENT));
}

/**
 * Clear the stored key and any in-memory session and notify the app that
 * the credential is no longer valid. Called on HTTP 401 responses and on WS
 * auth failures so the UI drops back to the login screen instead of showing
 * dead errors.
 */
export function notifyUnauthorized(): void {
  clearApiKey();
  clearSessionAuth();
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

// ---------------------------------------------------------------------------
// Request credential plumbing (LAMA-296). Every request path — normal JSON
// fetches, binary downloads, multipart uploads, and the WebSocket — resolves
// its credential through `requestCredential` so bearer and session modes can
// never drift apart. Session mode authenticates via the cookie (the browser
// sends it automatically on same-origin requests) and adds the CSRF header
// to non-safe methods only; bearer mode adds Authorization to everything.
// ---------------------------------------------------------------------------

/** HTTP methods that mutate server state — the only ones CSRF applies to. */
const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Header the session CSRF token travels in (ServerMobile wave-2 contract). */
export const CSRF_HEADER = "X-CSRF-Token";

type RequestCredential =
  | { kind: "bearer"; key: string }
  | { kind: "session"; csrfToken: string };

/**
 * Resolve the credential the current request should carry. A stored bearer
 * key ALWAYS wins — when that Authorization header turns out invalid the
 * request fails with 401; the code never silently drops the header to try
 * the cookie instead (server enforces the same rule). Null when logged out.
 */
function requestCredential(): RequestCredential | null {
  const key = getApiKey();
  if (key !== null) return { kind: "bearer", key };
  const session = getSessionAuth();
  if (session !== null) return { kind: "session", csrfToken: session.csrfToken };
  return null;
}

/** Apply the resolved credential to a header set for one request. */
function applyCredential(
  headers: Headers,
  credential: RequestCredential,
  method: string,
): void {
  if (credential.kind === "bearer") {
    headers.set("Authorization", `Bearer ${credential.key}`);
    return;
  }
  if (CSRF_METHODS.has(method)) {
    headers.set(CSRF_HEADER, credential.csrfToken);
  }
}

/** Absolute API path for `path` (which may or may not carry /api/v1). */
function apiUrl(path: string): string {
  return path.startsWith("/api/v1/")
    ? path
    : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}

/** 401 guard for callers that found no credential at all. */
function missingCredentialError(): ApiError {
  notifyUnauthorized();
  return new ApiError(401, "no active credential");
}

/**
 * `fetch` plus the LAMA-329 transport signals.
 *
 * Every request path here resolves its credential and then talks to the
 * network, so the connectivity banner's "did a request actually fail?" fact has
 * to be published from all of them — not only from the JSON helper. A resolved
 * response counts as success whatever its status (a 4xx/5xx means the server
 * answered and is a different problem); only a transport rejection counts as a
 * failure. Without this, a failed multipart upload leaves the banner saying
 * "Live updates paused" instead of "Server unreachable".
 */
export async function fetchWithTransportSignal(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init).then(
    (response) => {
      notifyRequestSucceeded();
      return response;
    },
    (error: unknown) => {
      notifyRequestFailed();
      throw error;
    },
  );
}

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const credential = requestCredential();
  if (credential === null) throw missingCredentialError();
  const headers = new Headers(init.headers);
  applyCredential(headers, credential, method);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetchWithTransportSignal(apiUrl(path), {
    ...init,
    headers,
    credentials: "same-origin",
  });
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

export type RetentionPolicyView = {
  policy: RetentionPolicy | null;
  policyDescription: string;
};

export type RetentionPolicyMutation = {
  enabled: boolean;
  rules?: RetentionRule[];
  applySmartPreset?: { daily?: number; weekly?: number; monthly?: number; yearly?: number };
};

export type RetentionSnapshotDecision = {
  id: string;
  createdAt: number;
  sizeBytes: number | null;
  successful: boolean;
  decision: RetentionDecision;
};

export type RetentionPreview = {
  policy: RetentionPolicy;
  policyDescription: string;
  evaluation: RetentionEvaluation;
  snapshots: RetentionSnapshotDecision[];
};

export type RetentionOutcome = {
  id: string;
  status: "deleted" | "absent" | "failed" | "skipped";
  error?: string | null;
};

export type RetentionPruneOutcome = {
  repository: string;
  ok: boolean;
  error?: string | null;
};

export type RetentionExecutionResult = {
  revalidatedPreview: RetentionPreview;
  outcomes: RetentionOutcome[];
  prune: { attempted: boolean; ok: boolean; outcomes: RetentionPruneOutcome[] } | null;
  operationLogId: number | null;
};

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
 * Fetch a binary response (e.g. an app-snapshot tarball) with the current
 * credential. A plain `<a href>` would not send `Authorization` (or carry
 * the CSRF rules), so callers that want to offer a download must fetch the
 * bytes and trigger a save via an object URL.
 */
async function apiBlob(path: string): Promise<Blob> {
  const credential = requestCredential();
  if (credential === null) throw missingCredentialError();
  const headers = new Headers();
  // Downloads are GETs: session mode authenticates via the cookie and needs
  // no CSRF header (cookie + CSRF only apply to non-safe mutations).
  applyCredential(headers, credential, "GET");
  const res = await fetchWithTransportSignal(apiUrl(path), { headers, credentials: "same-origin" });
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
  /**
   * GET /api/v1/auth/me — dual-mode identity (bearer principal or live
   * mobile session; see the LAMA-296 auth block above). Session responses
   * refresh the in-memory CSRF token from the authenticated auth metadata.
   */
  authMe: async () => {
    const info = await apiGet<AuthMeInfo>("/auth/me");
    if (info.mode === "session") {
      sessionAuth = {
        hostId: info.hostId,
        displayName: info.displayName,
        clientType: info.clientType,
        expiresAt: info.expiresAt,
        csrfToken: info.csrfToken,
      };
    }
    return info;
  },
  // LAMA-296: Android enrollment lifecycle (desktop "Add Android device"
  // flow). Creating an enrollment transactionally revokes any other still-
  // pending enrollment; the returned secret appears exactly once and only
  // inside the QR the phone scans.
  createMobileEnrollment: (opts: MobileEnrollmentCreateRequest = { webAdmin: true }) =>
    apiPost<MobileEnrollmentCreateResponse>("/mobile/enrollments", opts),
  getMobileEnrollment: (enrollmentId: string) =>
    apiGet<MobileEnrollmentStatusResponse>(
      `/mobile/enrollments/${encodeURIComponent(enrollmentId)}`,
    ),
  revokeMobileRegistration: (hostId: string, reason?: string) =>
    apiPost<MobileRegistrationRevokeResponse>(
      `/mobile/registrations/${encodeURIComponent(hostId)}/revoke`,
      { reason: reason ?? undefined },
    ),
  /** GET /api/v1/mobile/registrations — the admin-only projection of every
   *  paired device (most recent first, revoked rows included). This is the
   *  persistent listing behind the Admin "Android devices" panel (review
   *  finding 6): no secret hashes, grants, or enrollment ids on the wire. */
  listMobileRegistrations: () =>
    apiGet<MobileRegistrationSummary[]>("/mobile/registrations"),
  /** Stage 1: per-registration upload destinations (admin). There is no
   *  implicit upload access — an operator assigns an inbox explicitly. */
  listMobileRegistrationDestinations: (hostId: string) =>
    apiGet<{ destinations: MobileUploadDestination[] }>(
      `/mobile/registrations/${encodeURIComponent(hostId)}/destinations`,
    ),
  createMobileRegistrationDestination: (hostId: string, req: MobileUploadDestinationCreateRequest) =>
    apiPost<MobileUploadDestinationCreateResponse>(
      `/mobile/registrations/${encodeURIComponent(hostId)}/destinations`,
      req,
    ),
  updateMobileRegistrationDestination: (
    hostId: string,
    id: string,
    req: MobileUploadDestinationUpdateRequest,
  ) => apiPatch<MobileUploadDestinationCreateResponse>(
    `/mobile/registrations/${encodeURIComponent(hostId)}/destinations/${encodeURIComponent(id)}`,
    req,
  ),
  revokeMobileRegistrationDestination: (hostId: string, id: string) =>
    apiPost<MobileUploadDestinationRevokeResponse>(
      `/mobile/registrations/${encodeURIComponent(hostId)}/destinations/${encodeURIComponent(id)}/revoke`,
      {},
    ),
  /** POST /web-session/logout (CSRF-protected) — invalidates the current
   *  cookie session only; never touches the native registration. */
  mobileWebSessionLogout: () =>
    apiPost<MobileWebSessionLogoutResponse>("/mobile/web-session/logout", {}),
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
    backendId?: string | null;
    s3Bucket?: string | null;
  }) => apiPost<ApplicationProtection>("/apps/protections", body),
  updateAppProtection: (
    id: string,
    body: Partial<
      Pick<
        ApplicationProtection,
        "name" | "enabled" | "schedule" | "backendId" | "s3Bucket"
      >
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
    const credential = requestCredential();
    if (credential === null) throw missingCredentialError();
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
    const headers = new Headers();
    // Multipart: no Content-Type here — the browser sets the boundary.
    applyCredential(headers, credential, "POST");
    const res = await fetchWithTransportSignal(
      `/api/v1/apps/protections/${encodeURIComponent(protectionId)}/snapshots`,
      { method: "POST", headers, body: form, credentials: "same-origin" },
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
  // LAMA-325: snapshot retention (app protections + restic folders).
  getAppRetentionPolicy: (protectionId: string) =>
    apiGet<RetentionPolicyView>(`/apps/protections/${encodeURIComponent(protectionId)}/retention`),
  setAppRetentionPolicy: (protectionId: string, body: RetentionPolicyMutation) =>
    apiPut<RetentionPolicyView>(
      `/apps/protections/${encodeURIComponent(protectionId)}/retention`,
      body,
    ),
  previewAppRetention: (protectionId: string) =>
    apiPost<RetentionPreview>(
      `/apps/protections/${encodeURIComponent(protectionId)}/retention/preview`,
    ),
  executeAppRetention: (protectionId: string) =>
    apiPost<RetentionExecutionResult>(
      `/apps/protections/${encodeURIComponent(protectionId)}/retention/execute`,
      { confirm: true },
    ),
  getFolderRetentionPolicy: (folderId: string) =>
    apiGet<RetentionPolicyView>(`/folders/${encodeURIComponent(folderId)}/retention`),
  setFolderRetentionPolicy: (folderId: string, body: RetentionPolicyMutation) =>
    apiPut<RetentionPolicyView>(`/folders/${encodeURIComponent(folderId)}/retention`, body),
  previewFolderRetention: (folderId: string) =>
    apiPost<RetentionPreview>(`/folders/${encodeURIComponent(folderId)}/retention/preview`),
  executeFolderRetention: (folderId: string) =>
    apiPost<RetentionExecutionResult>(
      `/folders/${encodeURIComponent(folderId)}/retention/execute`,
      { confirm: true },
    ),
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
    const credential = requestCredential();
    if (credential === null) throw missingCredentialError();
    const form = new FormData();
    const filename = (file as { name?: unknown }).name;
    form.append(
      "file",
      file,
      typeof filename === "string" && filename.length > 0 ? filename : "upload.bin",
    );
    if (opts.path) form.append("path", opts.path);
    const headers = new Headers();
    // Multipart: no Content-Type here — the browser sets the boundary.
    applyCredential(headers, credential, "POST");
    const res = await fetchWithTransportSignal(
      `/api/v1/folders/${encodeURIComponent(folderId)}/files`,
      { method: "POST", headers, body: form, credentials: "same-origin" },
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
  // LAMA-321: on-demand recursive size of one folder-relative prefix.
  // browseSize starts the async job; browseSizeCached reads the server-side
  // result (fresh hit or { cached: false } when a job still needs to run).
  browseSize: (ref: BrowseRef, prefix: string) =>
    apiPost<BrowseJob>("/browse/size", { ref, prefix }),
  browseSizeCached: (ref: BrowseRef, prefix: string) => {
    const kind = ref.kind === "s3" ? "s3" : "local";
    const folderId = ref.kind === "s3" && ref.folderId ? `&folderId=${encodeURIComponent(ref.folderId)}` : "";
    const path = ref.path ? `&path=${encodeURIComponent(ref.path)}` : "";
    return apiGet<BrowsePrefixSizeResult>(
      `/browse/size?kind=${kind}${folderId}${path}&prefix=${encodeURIComponent(prefix)}`,
    );
  },
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
