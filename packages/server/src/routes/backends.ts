import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import type { Backend, BackendKind, S3Provider } from "@lamasync/core";
import {
  BACKEND_SELECT,
  type BackendRow,
  isBackendKind,
  isS3Provider,
  rowToBackend,
  setBackendSecret,
} from "../backends.ts";
import { encryptSecret, decryptSecret } from "../crypto.ts";
import { bumpConfigRevision } from "../config-revision.ts";

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
  return null;
}

function normalizeRegion(provider: S3Provider, region: string | null | undefined): string | null {
  if (provider === "exoscale") return "other-v2-signature";
  return region?.trim() || null;
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

export const backendsRoutes = new Elysia({ prefix: "/api/v1" })
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
           (id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          name,
          kind,
          provider,
          kind === "s3" ? endpoint : null,
          kind === "s3" ? region : null,
          kind === "s3" ? accessKeyId : null,
          kind === "s3" && secret !== "" ? encryptSecret(secret) : null,
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
      if (existing.kind === "s3" && (endpoint === "" || accessKeyId === "")) {
        set.status = 400;
        return { error: "S3 backends require s3Endpoint and s3AccessKeyId" };
      }
      const providerError = validateS3Settings(existing.kind as BackendKind, provider, endpoint, region);
      if (providerError) {
        set.status = 400;
        return { error: providerError };
      }
      activeDb.run(
        "UPDATE backends SET name = ?, s3_provider = ?, s3_endpoint = ?, s3_region = ?, s3_access_key_id = ? WHERE id = ?",
        [name, provider, endpoint, region, accessKeyId, params.backendId],
      );
      if (secret !== null) {
        setBackendSecret(activeDb, params.backendId, secret);
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
    "/backends/:backendId/test",
    async ({ params, set }) => {
      const existing = activeDb
        .query<BackendRow, [string]>(`${BACKEND_SELECT} WHERE id = ?`)
        .get(params.backendId);
      if (!existing) {
        set.status = 404;
        return { error: "Backend not found" };
      }
      if (existing.kind !== "s3") {
        set.status = 400;
        return { error: "connection test is only supported for S3 backends" };
      }
      const secret = decryptSecret(existing.s3_secret_key_enc);
      if (!secret) {
        set.status = 400;
        return { error: "backend has no stored secret" };
      }
      // Cheap connectivity check: `rclone lsd <remote>:` against a temp
      // config built from the backend row, 5s timeout.
      const config = [
        `[test]`,
        `type = s3`,
        `provider = ${existing.s3_provider === "aws" ? "AWS" : "Other"}`,
        `env_auth = false`,
        `access_key_id = ${existing.s3_access_key_id ?? ""}`,
        `secret_access_key = ${secret}`,
        `endpoint = ${existing.s3_endpoint ?? ""}`,
        ...(existing.s3_region ? [`region = ${existing.s3_region}`] : []),
      ].join("\n");
      const tmpConfig = `/tmp/lamasync-backend-test-${params.backendId}.conf`;
      await Bun.write(tmpConfig, config);
      const proc = Bun.spawn(
        ["rclone", "lsd", "test:", "--config", tmpConfig, "--timeout", "5s"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      try {
        await Bun.write(tmpConfig, "");
        await Bun.spawn(["rm", "-f", tmpConfig]).exited;
      } catch {
        // best-effort cleanup
      }
      if (code === 0) {
        return { ok: true, detail: "connection ok" };
      }
      const detail = stderr.trim().split("\n").pop() ?? "unknown rclone error";
      set.status = 502;
      return { ok: false, detail };
    },
    {
      params: t.Object({ backendId: t.String() }),
      detail: {
        summary: "Test a backend connection (rclone lsd, 5s timeout)",
        tags: ["Backends"],
        responses: {
          200: { description: "Connection ok" },
          400: { description: "Not an S3 backend or no secret" },
          404: { description: "Not found" },
          502: { description: "rclone reported an error" },
          401: { description: "Unauthorized" },
        },
      },
    },
  );
