import { Elysia, t } from "elysia";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { AppProfile } from "@lamasync/core";

import { db as defaultDb } from "../db.ts";

let activeDb: Database = defaultDb;
export function __setDb(next: Database): void {
  activeDb = next;
}

interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  emoji: string | null;
  color: string | null;
  paths: string;
  install_url: string | null;
  install_instructions: string | null;
  restore_instructions: string | null;
  created_at: number;
  updated_at: number;
}

type ProfilePaths = AppProfile["paths"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePaths(value: string): ProfilePaths {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return {};
    }
    const paths: ProfilePaths = {};
    for (const key of ["linux", "macos", "windows"] as const) {
      const candidate = parsed[key];
      if (Array.isArray(candidate)) {
        paths[key] = candidate.filter((entry): entry is string => typeof entry === "string");
      }
    }
    return paths;
  } catch {
    return {};
  }
}

function rowToProfile(row: ProfileRow): AppProfile {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    color: row.color,
    paths: parsePaths(row.paths),
    installUrl: row.install_url,
    installInstructions: row.install_instructions,
    restoreInstructions: row.restore_instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const profileFields = "id, name, description, emoji, color, paths, install_url, install_instructions, restore_instructions, created_at, updated_at";

function profileExists(profileId: string): boolean {
  return activeDb.query<{ id: string }, [string]>("SELECT id FROM app_profiles WHERE id = ?").get(profileId) !== null;
}

export const appProfilesRoutes = new Elysia({ prefix: "/api/v1" })
  .get(
    "/app-profiles",
    () => {
      const rows = activeDb.query<ProfileRow, []>(
        `SELECT ${profileFields} FROM app_profiles ORDER BY name COLLATE NOCASE`,
      ).all();
      return rows.map(rowToProfile);
    },
    {
      detail: {
        summary: "List user-defined app profiles",
        tags: ["App Profiles"],
        responses: { 200: { description: "App profile list" }, 401: { description: "Unauthorized" } },
      },
    },
  )
  .post(
    "/app-profiles",
    ({ body, set }) => {
      const name = body.name.trim();
      if (name.length === 0) {
        set.status = 400;
        return { error: "Profile name is required" };
      }
      const now = Date.now();
      const id = crypto.randomUUID();
      try {
        activeDb.run(
          "INSERT INTO app_profiles (id, name, description, emoji, color, paths, install_url, install_instructions, restore_instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, name, body.description ?? null, body.emoji ?? null, body.color ?? null, JSON.stringify(body.paths), body.installUrl ?? null, body.installInstructions ?? null, body.restoreInstructions ?? null, now, now],
        );
      } catch (error) {
        set.status = 409;
        return { error: error instanceof Error ? error.message : "Profile name already exists" };
      }
      const row = activeDb.query<ProfileRow, [string]>(
        `SELECT ${profileFields} FROM app_profiles WHERE id = ?`,
      ).get(id);
      set.status = 201;
      return rowToProfile(row!);
    },
    {
      body: t.Object({
        name: t.String(),
        description: t.Optional(t.Union([t.String(), t.Null()])),
        emoji: t.Optional(t.Union([t.String(), t.Null()])),
        color: t.Optional(t.Union([t.String(), t.Null()])),
        paths: t.Object({
          linux: t.Optional(t.Array(t.String())),
          macos: t.Optional(t.Array(t.String())),
          windows: t.Optional(t.Array(t.String())),
        }),
        installUrl: t.Optional(t.Union([t.String(), t.Null()])),
        installInstructions: t.Optional(t.Union([t.String(), t.Null()])),
        restoreInstructions: t.Optional(t.Union([t.String(), t.Null()])),
      }),
      detail: {
        summary: "Create a user-defined app profile",
        tags: ["App Profiles"],
        responses: { 201: { description: "App profile created" }, 400: { description: "Invalid profile" }, 409: { description: "Name already exists" }, 401: { description: "Unauthorized" } },
      },
    },
  )
  .put(
    "/app-profiles/:id",
    ({ params, body, set }) => {
      const existing = activeDb.query<{ id: string }, [string]>(
        "SELECT id FROM app_profiles WHERE id = ?",
      ).get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "App profile not found" };
      }
      const updates: string[] = [];
      const values: SQLQueryBindings[] = [];
      if (body.name !== undefined) {
        const name = body.name.trim();
        if (name.length === 0) {
          set.status = 400;
          return { error: "Profile name is required" };
        }
        updates.push("name = ?"); values.push(name);
      }
      if (body.description !== undefined) { updates.push("description = ?"); values.push(body.description); }
      if (body.emoji !== undefined) { updates.push("emoji = ?"); values.push(body.emoji); }
      if (body.color !== undefined) { updates.push("color = ?"); values.push(body.color); }
      if (body.paths !== undefined) { updates.push("paths = ?"); values.push(JSON.stringify(body.paths)); }
      if (body.installUrl !== undefined) { updates.push("install_url = ?"); values.push(body.installUrl); }
      if (body.installInstructions !== undefined) { updates.push("install_instructions = ?"); values.push(body.installInstructions); }
      if (body.restoreInstructions !== undefined) { updates.push("restore_instructions = ?"); values.push(body.restoreInstructions); }
      if (updates.length === 0) {
        set.status = 400;
        return { error: "No fields to update" };
      }
      updates.push("updated_at = ?"); values.push(Date.now());
      try {
        activeDb.run(`UPDATE app_profiles SET ${updates.join(", ")} WHERE id = ?`, [...values, params.id]);
      } catch (error) {
        set.status = 409;
        return { error: error instanceof Error ? error.message : "Failed to update app profile" };
      }
      const row = activeDb.query<ProfileRow, [string]>(
        `SELECT ${profileFields} FROM app_profiles WHERE id = ?`,
      ).get(params.id);
      return rowToProfile(row!);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Partial(t.Object({
        name: t.String(),
        description: t.Union([t.String(), t.Null()]),
        emoji: t.Union([t.String(), t.Null()]),
        color: t.Union([t.String(), t.Null()]),
        paths: t.Object({
          linux: t.Optional(t.Array(t.String())),
          macos: t.Optional(t.Array(t.String())),
          windows: t.Optional(t.Array(t.String())),
        }),
        installUrl: t.Union([t.String(), t.Null()]),
        installInstructions: t.Union([t.String(), t.Null()]),
        restoreInstructions: t.Union([t.String(), t.Null()]),
      })),
      detail: {
        summary: "Update a user-defined app profile",
        tags: ["App Profiles"],
        responses: { 200: { description: "App profile updated" }, 404: { description: "Not found" }, 409: { description: "Name already exists" }, 401: { description: "Unauthorized" } },
      },
    },
  )
  .delete(
    "/app-profiles/:id",
    ({ params, set }) => {
      const existing = activeDb.query<{ id: string }, [string]>(
        "SELECT id FROM app_profiles WHERE id = ?",
      ).get(params.id);
      if (!existing) {
        set.status = 404;
        return { error: "App profile not found" };
      }
      activeDb.run("UPDATE dotfile_manifests SET profile_id = NULL WHERE profile_id = ?", [params.id]);
      activeDb.run("DELETE FROM app_profiles WHERE id = ?", [params.id]);
      set.status = 204;
      return null;
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        summary: "Delete a user-defined app profile without deleting backups",
        tags: ["App Profiles"],
        responses: { 204: { description: "Profile removed; manifests preserved" }, 404: { description: "Not found" }, 401: { description: "Unauthorized" } },
      },
    },
  );
