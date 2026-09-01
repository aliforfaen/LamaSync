import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { B2ManagementConfig, Backend, BackendKind, S3Provider } from "@lamasync/core";
import {
  BACKEND_SELECT,
  type BackendRow,
  getBackend,
  isBackendKind,
  isS3Provider,
  rowToBackend,
  setBackendResticPassword,
  setBackendSecret,
} from "../backends.ts";
import {
  testLocalDirectory,
  testResticRepository,
  testS3Connection,
  createS3Bucket,
} from "../backend-test.ts";
import { encryptSecret, decryptSecret } from "../crypto.ts";
import { bumpConfigRevision } from "../config-revision.ts";
import { principalOf, requireAdmin } from "../auth.ts";

interface B2ManagementRow {
  endpoint: string;
  region: string;
  application_key_id: string;
  application_key_enc: string;
}

const B2_MANAGEMENT_SELECT =
  "SELECT endpoint, region, application_key_id, application_key_enc FROM b2_management_config WHERE id = 'default'";

function b2ManagementConfig(): B2ManagementRow | null {
  return activeDb.query<B2ManagementRow, []>(B2_MANAGEMENT_SELECT).get();
}

function b2ManagementView(row: B2ManagementRow | null): B2ManagementConfig | null {
  if (!row) return null;
  return {
    endpoint: row.endpoint,
    region: row.region,
    applicationKeyId: row.application_key_id,
    hasApplicationKey: row.application_key_enc !== "",
  };
}

function requireB2Manager(set: { status?: unknown }, store: unknown): boolean {
  if (requireAdmin({ principal: principalOf(store) })) return true;
  set.status = 403;
  return false;
}

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

function rowBackend(row: BackendRow): Backend {
  return rowToBackend(row);
}

/** S3 provider / endpoint / region validation for backends (moved from the
 *  old per-folder validation, LAMA-222). */
function validateS3Settings(
  kind: BackendKind,
  provider: S3Provider,
  endpoint: string,
  region: string | null,
): string | null {
  if (kind !== "s3") return null;
  if (endpoint === "") return "s3Endpoint is required for S3 backends";
  if (provider === "exoscale" && !/^sos-[a-z0-9-]+\.exo\.io$/i.test(endpoint.trim())) {
    return `Exoscale endpoint must match sos-ZONE.exo.io (got: ${endpoint})`;
  }
  if (provider === "aws" && (!region || region.trim() === "")) {
    return "AWS S3 provider requires s3Region";
  }
  if (provider === "b2") {
    if (!region || region.trim() === "") {
      return "Backblaze B2 requires the region from its S3 endpoint";
    }
    if (!/^https?:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com\/?$/i.test(endpoint.trim()) &&
        !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/i.test(endpoint.trim())) {
      return "Backblaze B2 endpoint must match s3.REGION.backblazeb2.com";
    }
  }
  return null;
}

function normalizeRegion(provider: S3Provider, region: string | null | undefined): string | null {
  if (provider === "exoscale") return "other-v2-signature";
  return region?.trim() || null;
}

/**
 * LAMA-238: resolve write-only fields (s3 secret, restic password) for the
 * draft connection test. The form value wins when provided; otherwise the
 * stored ciphertext of the referenced backend is decrypted, so an edit that
 * leaves the secret untouched still tests the real config.
 */
export function resolveDraftWriteSecrets(
  providedSecret: string,
  providedPassword: string,
  stored: BackendRow | null,
): { secret: string; password: string } {
  return {
    secret:
      providedSecret !== ""
        ? providedSecret
        : (stored ? decryptSecret(stored.s3_secret_key_enc) ?? "" : ""),
    password:
      providedPassword !== ""
        ? providedPassword
        : (stored ? decryptSecret(stored.restic_password_enc) ?? "" : ""),
  };
}

/** How many folders currently reference this backend (for the delete guard
 *  and the list view's "# folders" column). */
function folderCount(backendId: string): number {
  return (
    activeDb
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM folders WHERE backend_id = ?",
      )
      .get(backendId)?.c ?? 0
  );
}

/** Per-kind backend field validation shared by create and PATCH. Returns
 *  an error string, or null when the input is valid. `local` and `nfs` are
 *  named connection targets for a server-side directory (rclone type =
 *  local); `restic` centralizes the repository + password pair. */
function validateKindFields(
  kind: BackendKind,
  localPath: string | undefined,
  resticRepository: string | undefined,
  resticPassword: string | undefined,
  opts: { creating: boolean },
): string | null {
  if (kind === "local" || kind === "nfs") {
    if (opts.creating && (localPath ?? "").trim() === "") {
      return `${kind} backends require localPath`;
    }
    if (localPath !== undefined && !localPath.trim().startsWith("/")) {
      return `${kind} localPath must be an absolute path (starting with /)`;
    }
  }
  if (kind === "restic") {
    if (opts.creating) {
      if ((resticRepository ?? "").trim() === "" || (resticPassword ?? "") === "") {
        return "restic backends require resticRepository and resticPassword";
      }
    } else if (resticRepository !== undefined && resticRepository.trim() === "") {
      return "resticRepository cannot be empty";
    }
  }
  return null;
}

export const backendsRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/admin/b2-management",
    ({ set, store }) => {
      if (!requireB2Manager(set, store)) return { error: "Admin access required" };
      return b2ManagementView(b2ManagementConfig());
    },
    { detail: { summary: "Read Backblaze B2 bucket-management configuration", tags: ["Admin"] } },
  )
  .put(
    "/admin/b2-management",
    ({ body, set, store }) => {
      if (!requireB2Manager(set, store)) return { error: "Admin access required" };
      const b = body as {
        endpoint?: unknown; region?: unknown; applicationKeyId?: unknown; applicationKey?: unknown;
      };
      const endpoint = typeof b.endpoint === "string" ? b.endpoint.trim() : "";
      const region = typeof b.region === "string" ? b.region.trim() : "";
      const applicationKeyId = typeof b.applicationKeyId === "string" ? b.applicationKeyId.trim() : "";
      const applicationKey = typeof b.applicationKey === "string" ? b.applicationKey : "";
      const existing = b2ManagementConfig();
      if (endpoint === "" || region === "" || applicationKeyId === "" || (!existing && applicationKey === "")) {
        set.status = 400;
        return { error: "endpoint, region, application key ID, and application key are required" };
      }
      const settingsError = validateS3Settings("s3", "b2", endpoint, region);
      if (settingsError) {
        set.status = 400;
        return { error: settingsError };
      }
      const encryptedKey = applicationKey !== "" ? encryptSecret(applicationKey) : existing?.application_key_enc;
      if (!encryptedKey) {
        set.status = 400;
        return { error: "application key is required" };
      }
      activeDb.run(
        "INSERT INTO b2_management_config (id, endpoint, region, application_key_id, application_key_enc, updated_at) VALUES ('default', ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET endpoint = excluded.endpoint, region = excluded.region, application_key_id = excluded.application_key_id, application_key_enc = excluded.application_key_enc, updated_at = excluded.updated_at",
        [endpoint, region, applicationKeyId, encryptedKey, Date.now()],
      );
      return b2ManagementView(b2ManagementConfig());
    },
    {
      body: t.Object({ endpoint: t.String(), region: t.String(), applicationKeyId: t.String(), applicationKey: t.Optional(t.String()) }),
      detail: { summary: "Save encrypted Backblaze B2 bucket-management credentials", tags: ["Admin"] },
    },
  )
  .post(
    "/admin/b2-management/test",
    async ({ set, store }) => {
      if (!requireB2Manager(set, store)) return { error: "Admin access required" };
      const config = b2ManagementConfig();
      const applicationKey = config ? decryptSecret(config.application_key_enc) : null;
      if (!config || !applicationKey) {
        set.status = 409;
        return { error: "Backblaze B2 bucket-management credentials are not configured" };
      }
      const outcome = await testS3Connection({ provider: "b2", accessKeyId: config.application_key_id, secretAccessKey: applicationKey, endpoint: config.endpoint, region: config.region });
      if (!outcome.ok) set.status = 502;
      return outcome;
    },
    { detail: { summary: "Test Backblaze B2 bucket-management credentials", tags: ["Admin"] } },
  )
  .get(
    "/backends",
    () => {
      const rows = activeDb
        .query<BackendRow, []>(`${BACKEND_SELECT} ORDER BY name ASC`)
        .all();
      return rows.map((row) => ({
        ...rowBackend(row),
        // LAMA-222: the UI shows how many folders use a backend before
        // allowing delete. `hasSecret` on Backend covers the credentials.
        folderCount: folderCount(row.id),
      }));
    },
    {
      detail: {
        summary: "List reusable backends",
        tags: ["Backends"],
        responses: {
          200: { description: "Backend list" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/backends/b2-buckets",
    async ({ body, set }) => {
      // Bucket creation uses the separately stored account-level B2 key, not
      // a destination's transfer key. This preserves least privilege for
      // ordinary backup operations.
      const b = body as { name?: unknown };
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!/^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/.test(name) || name.startsWith("b2-")) {
        set.status = 400;
        return { error: "B2 bucket name must be 6–63 lowercase letters, numbers, or hyphens, and cannot start with b2-" };
      }
      const config = b2ManagementConfig();
      const applicationKey = config ? decryptSecret(config.application_key_enc) : null;
      if (!config || !applicationKey) {
        set.status = 409;
        return { error: "Configure the Backblaze B2 bucket-management key in Admin first" };
      }
      const outcome = await createS3Bucket({
        provider: "b2",
        accessKeyId: config.application_key_id,
        secretAccessKey: applicationKey,
        endpoint: config.endpoint,
        region: config.region,
      }, name);
      if (!outcome.ok) set.status = outcome.status;
      return outcome;
    },
    {
      body: t.Object({
        name: t.String(),
      }),
      detail: {
        summary: "Create a Backblaze B2 bucket from a draft S3 configuration",
        tags: ["Backends"],
        responses: {
          200: { description: "Bucket created" },
          400: { description: "Invalid B2 configuration or bucket name" },
          502: { description: "Backblaze/rclone reported an error" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/backends",
    ({ body, set }) => {
      const b = body as {
        name?: unknown;
        kind?: unknown;
        s3Provider?: unknown;
        s3Endpoint?: unknown;
        s3Region?: unknown;
        s3AccessKeyId?: unknown;
        s3SecretAccessKey?: unknown;
        localPath?: unknown;
        resticRepository?: unknown;
        resticPassword?: unknown;
      };
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (name === "") {
        set.status = 400;
        return { error: "name is required" };
      }
      const kind: BackendKind = isBackendKind(typeof b.kind === "string" ? b.kind : null)
        ? (b.kind as BackendKind)
        : "s3";
      const provider: S3Provider = isS3Provider(typeof b.s3Provider === "string" ? b.s3Provider : null)
        ? (b.s3Provider as S3Provider)
        : "other";
      const endpoint = typeof b.s3Endpoint === "string" ? b.s3Endpoint.trim() : "";
      const accessKeyId = typeof b.s3AccessKeyId === "string" ? b.s3AccessKeyId.trim() : "";
      const secret = typeof b.s3SecretAccessKey === "string" ? b.s3SecretAccessKey : "";
      const region = normalizeRegion(provider, typeof b.s3Region === "string" ? b.s3Region : null);
      const localPath = typeof b.localPath === "string" ? b.localPath.trim() : "";
      const resticRepository =
        typeof b.resticRepository === "string" ? b.resticRepository.trim() : "";
      const resticPassword = typeof b.resticPassword === "string" ? b.resticPassword : "";
      if (kind === "s3") {
        if (endpoint === "" || accessKeyId === "" || secret === "") {
          set.status = 400;
          return { error: "S3 backends require s3Endpoint, s3AccessKeyId and s3SecretAccessKey" };
        }
        const providerError = validateS3Settings(kind, provider, endpoint, region);
        if (providerError) {
          set.status = 400;
          return { error: providerError };
        }
      }
      const kindError = validateKindFields(kind, localPath, resticRepository, resticPassword, {
        creating: true,
      });
      if (kindError) {
        set.status = 400;
        return { error: kindError };
      }
      const existing = activeDb
        .query<{ id: string }, [string]>(
          "SELECT id FROM backends WHERE lower(name) = lower(?)",
        )
        .get(name);
      if (existing) {
        set.status = 409;
        return { error: `backend name '${name}' already in use` };
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      activeDb.run(
        `INSERT INTO backends
           (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc,
            local_path, restic_repository, restic_password_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          kind,
          provider,
          kind === "s3" ? endpoint : null,
          kind === "s3" ? region : null,
          kind === "s3" ? accessKeyId : null,
          kind === "s3" && secret !== "" ? encryptSecret(secret) : null,
          kind === "local" || kind === "nfs" ? localPath : null,
          kind === "restic" ? resticRepository : null,
          kind === "restic" && resticPassword !== "" ? encryptSecret(resticPassword) : null,
          now,
        ],
      );
      const row = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(id);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load backend after insert" };
      }
      set.status = 201;
      return rowBackend(row);
    },
    {
      body: t.Object({
        name: t.String(),
        kind: t.Optional(t.String()),
        s3Provider: t.Optional(t.String()),
        s3Endpoint: t.Optional(t.String()),
        s3Region: t.Optional(t.String()),
        s3AccessKeyId: t.Optional(t.String()),
        s3SecretAccessKey: t.Optional(t.String()),
        localPath: t.Optional(t.String()),
        resticRepository: t.Optional(t.String()),
        resticPassword: t.Optional(t.String()),
      }),
      detail: {
        summary: "Create a reusable backend (S3 credentials stored once)",
        tags: ["Backends"],
        responses: {
          201: { description: "Backend created" },
          400: { description: "Invalid input" },
          409: { description: "Name already in use" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .get(
    "/backends/:backendId",
    ({ params, set }) => {
      const row = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(params.backendId);
      if (!row) {
        set.status = 404;
        return { error: "Backend not found" };
      }
      return rowBackend(row);
    },
    {
      params: t.Object({ backendId: t.String() }),
      detail: {
        summary: "Get a single backend",
        tags: ["Backends"],
        responses: {
          200: { description: "Backend record" },
          404: { description: "Not found" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .patch(
    "/backends/:backendId",
    ({ params, body, set }) => {
      const existing = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(params.backendId);
      if (!existing) {
        set.status = 404;
        return { error: "Backend not found" };
      }
      const b = body as {
        name?: unknown;
        s3Provider?: unknown;
        s3Endpoint?: unknown;
        s3Region?: unknown;
        s3AccessKeyId?: unknown;
        s3SecretAccessKey?: unknown;
        localPath?: unknown;
        resticRepository?: unknown;
        resticPassword?: unknown;
      };
      const name = typeof b.name === "string" ? b.name.trim() : existing.name;
      if (name === "") {
        set.status = 400;
        return { error: "name cannot be empty" };
      }
      if (name.toLowerCase() !== existing.name.toLowerCase()) {
        const collision = activeDb
          .query<{ id: string }, [string, string]>(
            "SELECT id FROM backends WHERE lower(name) = lower(?) AND id != ?",
          )
          .get(name, params.backendId);
        if (collision) {
          set.status = 409;
          return { error: `backend name '${name}' already in use` };
        }
      }
      const provider: S3Provider = isS3Provider(typeof b.s3Provider === "string" ? b.s3Provider : null)
        ? (b.s3Provider as S3Provider)
        : (isS3Provider(existing.s3_provider) ? existing.s3_provider : "other");
      const endpoint = typeof b.s3Endpoint === "string" ? b.s3Endpoint.trim() : (existing.s3_endpoint ?? "");
      const accessKeyId = typeof b.s3AccessKeyId === "string" ? b.s3AccessKeyId.trim() : (existing.s3_access_key_id ?? "");
      const secret = typeof b.s3SecretAccessKey === "string" && b.s3SecretAccessKey !== ""
        ? b.s3SecretAccessKey
        : null;
      const region = normalizeRegion(provider, typeof b.s3Region === "string" ? b.s3Region : (existing.s3_region ?? null));
      const localPath = typeof b.localPath === "string" ? b.localPath.trim() : undefined;
      const resticRepository =
        typeof b.resticRepository === "string" ? b.resticRepository.trim() : undefined;
      const resticPassword =
        typeof b.resticPassword === "string" && b.resticPassword !== ""
          ? b.resticPassword
          : undefined;
      const existingKind = existing.kind as BackendKind;
      if (existingKind === "s3" && (endpoint === "" || accessKeyId === "")) {
        set.status = 400;
        return { error: "S3 backends require s3Endpoint and s3AccessKeyId" };
      }
      const providerError = validateS3Settings(existingKind, provider, endpoint, region);
      if (providerError) {
        set.status = 400;
        return { error: providerError };
      }
      const kindError = validateKindFields(
        existingKind,
        localPath,
        resticRepository,
        resticPassword,
        { creating: false },
      );
      if (kindError) {
        set.status = 400;
        return { error: kindError };
      }
      activeDb.run(
        "UPDATE backends SET name = ?, s3_provider = ?, s3_endpoint = ?, s3_region = ?, s3_access_key_id = ?, local_path = ?, restic_repository = ? WHERE id = ?",
        [
          name,
          provider,
          endpoint,
          region,
          accessKeyId,
          existingKind === "local" || existingKind === "nfs"
            ? localPath ?? existing.local_path
            : existing.local_path,
          existingKind === "restic"
            ? resticRepository ?? existing.restic_repository
            : existing.restic_repository,
          params.backendId,
        ],
      );
      if (secret !== null) {
        setBackendSecret(activeDb, params.backendId, secret);
      }
      if (resticPassword !== undefined && existingKind === "restic") {
        setBackendResticPassword(activeDb, params.backendId, resticPassword);
      }
      // LAMA-222: rotating a credential affects every folder using this
      // backend — bump all hosts so daemons re-pull the rclone config.
      bumpConfigRevision();
      const row = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(params.backendId);
      if (!row) {
        set.status = 500;
        return { error: "Failed to load backend after update" };
      }
      return rowBackend(row);
    },
    {
      params: t.Object({ backendId: t.String() }),
      body: t.Object({
        name: t.Optional(t.String()),
        s3Provider: t.Optional(t.String()),
        s3Endpoint: t.Optional(t.String()),
        s3Region: t.Optional(t.String()),
        s3AccessKeyId: t.Optional(t.String()),
        s3SecretAccessKey: t.Optional(t.String()),
        localPath: t.Optional(t.String()),
        resticRepository: t.Optional(t.String()),
        resticPassword: t.Optional(t.String()),
      }),
      detail: {
        summary: "Update a backend (e.g. rotate credentials)",
        tags: ["Backends"],
        responses: {
          200: { description: "Updated backend" },
          400: { description: "Invalid input" },
          404: { description: "Not found" },
          409: { description: "Name already in use" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .delete(
    "/backends/:backendId",
    ({ params, set }) => {
      const existing = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(params.backendId);
      if (!existing) {
        set.status = 404;
        return { error: "Backend not found" };
      }
      const inUse = folderCount(params.backendId);
      if (inUse > 0) {
        set.status = 409;
        return {
          error: `backend '${existing.name}' is used by ${inUse} folder(s); unassign them first`,
        };
      }
      activeDb.run("DELETE FROM backends WHERE id = ?", [params.backendId]);
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ backendId: t.String() }),
      detail: {
        summary: "Delete a backend (must be unused)",
        tags: ["Backends"],
        responses: {
          204: { description: "Backend removed" },
          404: { description: "Not found" },
          409: { description: "Backend still referenced by folders" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/backends/test",
    async ({ body, set }) => {
      // LAMA-238: connection test for a backend DRAFT — the values from the
      // "Add backend" / "Edit backend" form before anything is persisted.
      // Write-only fields (s3 secret, restic password) fall back to the
      // stored value when `backendId` points at an existing backend, so an
      // edit that leaves the secret untouched still tests the real config.
      const b = body as {
        kind?: unknown;
        backendId?: unknown;
        s3Provider?: unknown;
        s3Endpoint?: unknown;
        s3Region?: unknown;
        s3AccessKeyId?: unknown;
        s3SecretAccessKey?: unknown;
        localPath?: unknown;
        resticRepository?: unknown;
        resticPassword?: unknown;
      };
      const kind: BackendKind = isBackendKind(typeof b.kind === "string" ? b.kind : null)
        ? (b.kind as BackendKind)
        : "s3";
      const provider: S3Provider = isS3Provider(typeof b.s3Provider === "string" ? b.s3Provider : null)
        ? (b.s3Provider as S3Provider)
        : "other";
      const endpoint = typeof b.s3Endpoint === "string" ? b.s3Endpoint.trim() : "";
      const accessKeyId = typeof b.s3AccessKeyId === "string" ? b.s3AccessKeyId.trim() : "";
      const secret = typeof b.s3SecretAccessKey === "string" ? b.s3SecretAccessKey : "";
      const region = normalizeRegion(provider, typeof b.s3Region === "string" ? b.s3Region : null);
      const localPath = typeof b.localPath === "string" ? b.localPath.trim() : "";
      const resticRepository =
        typeof b.resticRepository === "string" ? b.resticRepository.trim() : "";
      const resticPassword = typeof b.resticPassword === "string" ? b.resticPassword : "";
      const stored =
        typeof b.backendId === "string" && b.backendId.trim() !== ""
          ? getBackend(activeDb, b.backendId.trim())
          : null;
      const { secret: effectiveSecret, password: effectivePassword } =
        resolveDraftWriteSecrets(secret, resticPassword, stored);

      if (kind === "s3") {
        if (endpoint === "" || accessKeyId === "" || effectiveSecret === "") {
          set.status = 400;
          return {
            error: "S3 backends require s3Endpoint, s3AccessKeyId and s3SecretAccessKey",
          };
        }
        const providerError = validateS3Settings(kind, provider, endpoint, region);
        if (providerError) {
          set.status = 400;
          return { error: providerError };
        }
        const outcome = await testS3Connection({
          provider,
          accessKeyId,
          secretAccessKey: effectiveSecret,
          endpoint,
          region,
        });
        if (!outcome.ok) set.status = 502;
        return outcome;
      }
      if (kind === "local" || kind === "nfs") {
        if (localPath === "") {
          set.status = 400;
          return { error: `${kind} backends require localPath` };
        }
        if (!localPath.startsWith("/")) {
          set.status = 400;
          return { error: `${kind} localPath must be an absolute path (starting with /)` };
        }
        const outcome = testLocalDirectory(localPath);
        if (!outcome.ok) set.status = 502;
        return outcome;
      }
      if (kind === "restic") {
        if (resticRepository === "" || effectivePassword === "") {
          set.status = 400;
          return { error: "restic backends require resticRepository and resticPassword" };
        }
        const outcome = await testResticRepository(resticRepository, effectivePassword);
        if (!outcome.ok) set.status = 502;
        return outcome;
      }
      set.status = 400;
      return { error: `connection test is not supported for kind '${kind}'` };
    },
    {
      body: t.Object({
        kind: t.Optional(t.String()),
        backendId: t.Optional(t.String()),
        s3Provider: t.Optional(t.String()),
        s3Endpoint: t.Optional(t.String()),
        s3Region: t.Optional(t.String()),
        s3AccessKeyId: t.Optional(t.String()),
        s3SecretAccessKey: t.Optional(t.String()),
        localPath: t.Optional(t.String()),
        resticRepository: t.Optional(t.String()),
        resticPassword: t.Optional(t.String()),
      }),
      detail: {
        summary: "Test an unsaved backend configuration (create/edit form)",
        tags: ["Backends"],
        responses: {
          200: { description: "Connection ok" },
          400: { description: "Invalid configuration for testing" },
          502: { description: "rclone/restic reported an error" },
          401: { description: "Unauthorized" },
        },
      },
    },
  )
  .post(
    "/backends/:backendId/test",
    async ({ params, set }) => {
      const existing = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(params.backendId);
      if (!existing) {
        set.status = 404;
        return { error: "Backend not found" };
      }
      if (existing.kind === "s3") {
        const secret = decryptSecret(existing.s3_secret_key_enc);
        if (!secret) {
          set.status = 400;
          return { error: "backend has no stored secret" };
        }
        const outcome = await testS3Connection({
          provider: existing.s3_provider ?? "other",
          accessKeyId: existing.s3_access_key_id ?? "",
          secretAccessKey: secret,
          endpoint: existing.s3_endpoint ?? "",
          region: existing.s3_region ?? null,
        });
        if (!outcome.ok) set.status = 502;
        return outcome;
      }
      if (existing.kind === "local" || existing.kind === "nfs") {
        const path = (existing.local_path ?? "").trim();
        if (path === "") {
          set.status = 400;
          return { error: "backend has no local path configured" };
        }
        const outcome = testLocalDirectory(path);
        if (!outcome.ok) set.status = 502;
        return outcome;
      }
      if (existing.kind === "restic") {
        const repository = (existing.restic_repository ?? "").trim();
        const password = decryptSecret(existing.restic_password_enc);
        if (repository === "" || !password) {
          set.status = 400;
          return { error: "restic backend is missing repository or password" };
        }
        const outcome = await testResticRepository(repository, password);
        if (!outcome.ok) set.status = 502;
        return outcome;
      }
      set.status = 400;
      return { error: `connection test is not supported for kind '${existing.kind}'` };
    },
    {
      params: t.Object({ backendId: t.String() }),
      detail: {
        summary: "Test a backend connection (S3/local/nfs via rclone or fs check, restic via snapshots)",
        tags: ["Backends"],
        responses: {
          200: { description: "Connection ok" },
          400: { description: "Invalid backend for testing" },
          404: { description: "Not found" },
          502: { description: "rclone/restic reported an error" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
