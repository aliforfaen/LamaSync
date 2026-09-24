// LAMA-346 Stage 2f — the operator's seed-pilot surface (admin only).
//
//   GET    /api/v1/seed-pilot         the stored authorization + pickable options
//   PUT    /api/v1/seed-pilot         authorize (or reconfigure) one folder+pair
//   DELETE /api/v1/seed-pilot         switch it off
//   POST   /api/v1/seed-pilot/probe   prove the backend can use the bucket
//
// Everything here is admin-only and NONE of it ever returns a credential: the
// options block carries a backend's NAME, kind, endpoint, region and access key
// ID (an identifier, already exposed by the backends list) plus a `hasSecret`
// boolean. The secret itself is decrypted only inside `seed-pilot.ts` for the
// probe and for a party's own host config.
//
// The readiness probe is not decoration: an existing backend's key may be
// scoped to a different bucket, and the pilot refuses to run until the space has
// been proven writable. That is why `PUT` resets the verdict and `probe` is a
// separate, explicit act.

import { Elysia, t } from "elysia";
import type { Database } from "bun:sqlite";
import { db as defaultDb } from "../db.ts";
import {
  emptySeedPilotConfig,
  parseSeedPilotUpdatePayload,
  seedPilotEligibility,
  seedPilotSummary,
  type SeedPilotConfig,
} from "@lamasync/core";
import { principalOf, requireAdmin } from "../auth.ts";
import {
  clearSeedPilotConfig,
  getSeedPilotConfig,
  probeAndRecordSeedRelayReadiness,
  setSeedPilotConfig,
} from "../seed-pilot.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface FolderOptionRow {
  id: string;
  name: string;
  type: string;
}
interface HostOptionRow {
  id: string;
  hostname: string;
  status: string;
}
interface BackendOptionRow {
  id: string;
  name: string;
  kind: string;
  s3_provider: string | null;
  s3_endpoint: string | null;
  s3_region: string | null;
  s3_access_key_id: string | null;
  s3_secret_key_enc: string | null;
}

/** Everything the operator may choose from — ids and labels only, no secrets. */
function seedPilotOptions(): {
  folders: Array<{ id: string; name: string; type: string }>;
  hosts: Array<{ id: string; hostname: string; status: string }>;
  backends: Array<{
    id: string;
    name: string;
    kind: string;
    provider: string;
    endpoint: string | null;
    region: string | null;
    accessKeyId: string | null;
    hasSecret: boolean;
  }>;
} {
  return {
    folders: activeDb
      .query<FolderOptionRow, []>("SELECT id, name, type FROM folders ORDER BY name")
      .all(),
    hosts: activeDb
      .query<HostOptionRow, []>("SELECT id, hostname, status FROM hosts ORDER BY hostname")
      .all(),
    backends: activeDb
      .query<BackendOptionRow, []>(
        `SELECT id, name, kind, s3_provider, s3_endpoint, s3_region, s3_access_key_id, s3_secret_key_enc
           FROM backends ORDER BY name`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        provider: row.s3_provider ?? "other",
        endpoint: row.s3_endpoint,
        region: row.s3_region,
        accessKeyId: row.s3_access_key_id,
        hasSecret: row.s3_secret_key_enc !== null && row.s3_secret_key_enc !== "",
      })),
  };
}

/** The wire shape: the config, one summary sentence, and the pickable options. */
function seedPilotView(config: SeedPilotConfig | null): Record<string, unknown> {
  const empty = config ?? emptySeedPilotConfig();
  return {
    config: empty,
    summary: seedPilotSummary(empty),
    options: seedPilotOptions(),
  };
}

export const seedPilotRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/seed-pilot",
    ({ set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return seedPilotView(getSeedPilotConfig(activeDb));
    },
    {
      detail: {
        summary: "The seed pilot: the one authorized folder and source/target pair, plus the temporary seed space",
        tags: ["Seed Pilot"],
        responses: {
          200: { description: "Pilot config, a summary sentence, and the pickable folders/hosts/backends" },
          401: { description: "Unauthorized" },
          403: { description: "Admin only" },
        },
      },
    },
  )
  .put(
    "/seed-pilot",
    ({ body, set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const parsed = parseSeedPilotUpdatePayload(body);
      if (!parsed.ok) {
        set.status = 400;
        return { error: parsed.error };
      }
      const payload = parsed.payload;
      if (payload.enabled) {
        // The scope must be real: a pilot that names a folder or a device that
        // does not exist would authorize a seed that can never run, and the
        // operator would not learn why until a plan failed.
        const folder = activeDb
          .query<{ id: string }, [string]>("SELECT id FROM folders WHERE id = ?")
          .get(payload.folderId ?? "");
        if (!folder) {
          set.status = 404;
          return { error: "That folder does not exist." };
        }
        const assigned = activeDb
          .query<{ host_id: string }, [string, string, string]>(
            "SELECT host_id FROM folder_assignments WHERE folder_id = ? AND host_id IN (?, ?)",
          )
          .all(payload.folderId ?? "", payload.sourceHostId ?? "", payload.targetHostId ?? "")
          .map((row) => row.host_id);
        if (!assigned.includes(payload.sourceHostId ?? "")) {
          set.status = 409;
          return { error: "The source device is not assigned to that folder." };
        }
        if (!assigned.includes(payload.targetHostId ?? "")) {
          set.status = 409;
          return { error: "The target device is not assigned to that folder." };
        }
        const backend = activeDb
          .query<{ kind: string; s3_secret_key_enc: string | null }, [string]>(
            "SELECT kind, s3_secret_key_enc FROM backends WHERE id = ?",
          )
          .get(payload.backendId ?? "");
        if (!backend) {
          set.status = 404;
          return { error: "That storage backend does not exist." };
        }
        if (backend.kind !== "s3") {
          set.status = 409;
          return { error: "The temporary seed space must use an existing S3 backend." };
        }
        if (backend.s3_secret_key_enc === null || backend.s3_secret_key_enc === "") {
          set.status = 409;
          return { error: "That storage backend has no stored S3 secret, so it cannot be used as the seed space." };
        }
      }
      const config = setSeedPilotConfig(activeDb, {
        enabled: payload.enabled,
        folderId: payload.folderId,
        sourceHostId: payload.sourceHostId,
        targetHostId: payload.targetHostId,
        backendId: payload.backendId,
        bucket: payload.bucket,
      });
      return {
        ...seedPilotView(config),
        // The verdict the operator now has, in the same shape the plan API
        // uses, so the UI never has to re-derive the rule.
        eligibility: payload.enabled
          ? seedPilotEligibility(config, {
              folderId: payload.folderId ?? "",
              sourceHostId: payload.sourceHostId ?? "",
              targetHostId: payload.targetHostId ?? "",
            })
          : null,
      };
    },
    {
      body: t.Object({
        enabled: t.Boolean(),
        folderId: t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()])),
        sourceHostId: t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()])),
        targetHostId: t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()])),
        backendId: t.Optional(t.Union([t.String({ maxLength: 128 }), t.Null()])),
        bucket: t.Optional(t.Union([t.String({ maxLength: 63 }), t.Null()])),
        confirm: t.Literal(true),
      }),
      detail: {
        summary: "Authorize (or reconfigure) the seed pilot: one folder, one source/target pair, one backend and bucket",
        tags: ["Seed Pilot"],
        responses: {
          200: { description: "Stored pilot config with the current eligibility verdict" },
          400: { description: "Malformed payload, or an invalid bucket name" },
          401: { description: "Unauthorized" },
          403: { description: "Admin only" },
          404: { description: "Folder or backend not found" },
          409: { description: "A device is not assigned to the folder, or the backend is not an S3 backend with a secret" },
          422: { description: "Body failed schema validation (confirm must be true)" },
        },
      },
    },
  )
  .delete(
    "/seed-pilot",
    ({ set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      return seedPilotView(clearSeedPilotConfig(activeDb));
    },
    {
      detail: {
        summary: "Switch the seed pilot off (no seed can run until an operator authorizes one again)",
        tags: ["Seed Pilot"],
        responses: {
          200: { description: "The cleared pilot config" },
          401: { description: "Unauthorized" },
          403: { description: "Admin only" },
        },
      },
    },
  )
  .post(
    "/seed-pilot/probe",
    async ({ set, request }) => {
      if (!requireAdmin({ principal: principalOf(request) })) {
        set.status = 403;
        return { error: "Forbidden" };
      }
      const result = await probeAndRecordSeedRelayReadiness(activeDb);
      const config = result.config;
      if (config === null) {
        set.status = 400;
        return { error: "The seed pilot is not configured, so there is no seed space to probe." };
      }
      return {
        ...seedPilotView(config),
        probe: { ok: result.ok, detail: result.ok ? result.config.readiness.message : result.error },
      };
    },
    {
      detail: {
        summary: "Prove the pilot's backend can write to and delete from the temporary seed bucket",
        tags: ["Seed Pilot"],
        responses: {
          200: { description: "The stored readiness verdict (a failing probe is reported in `probe`, not as an HTTP error)" },
          400: { description: "No pilot configured, or no resolvable backend to probe" },
          401: { description: "Unauthorized" },
          403: { description: "Admin only" },
        },
      },
    },
  );
