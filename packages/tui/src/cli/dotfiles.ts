/**
 * `lamasync dotfiles list|upload|download|manifests` (LAMA-231).
 *
 * Tarball push/pull wraps `client.uploadDotfile`/`client.downloadDotfile`.
 * `manifests` covers CRUD against `/api/v1/dotfiles/manifests`. The
 * multipart upload takes a path the operator can read; downloads are
 * written to `--out <path>` (or stdout if omitted).
 */

import { existsSync, writeFileSync } from "fs";
import { stat } from "fs/promises";

import type { DotfileManifest, DotfileVersion } from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const host = flagString(flags, "host");
  let manifests: DotfileManifest[];
  try {
    manifests = await client.client.listDotfileManifests(host ?? undefined);
  } catch (err) {
    throw wrapApiError(err, "dotfiles list");
  }
  if (json) {
    printJson(manifests);
    return;
  }
  printTable(
    [
      { header: "APP", key: "appName" },
      { header: "HOST", key: "hostId" },
      { header: "PATHS", key: "paths" },
      { header: "SCHEDULE", key: "schedule" },
      { header: "LAST", key: "lastSyncLabel" },
      { header: "ID", key: "id" },
    ],
    manifests.map((m) => ({
      appName: m.appName,
      hostId: m.hostId === "_global" ? "(global)" : m.hostId,
      paths: (m.paths ?? []).join(", "),
      schedule: m.schedule ?? "",
      lastSyncLabel: m.lastSyncAt ? new Date(m.lastSyncAt).toISOString() : "",
      id: m.id,
    })),
  );
}

export async function runManifestsList(ctx: CliContext): Promise<void> {
  return runList(ctx);
}

interface CreateManifestBody {
  appName: string;
  hostId?: string;
  paths: string[];
  excludes?: string[];
  schedule?: string;
  instructions?: string;
}

export async function runManifestCreate(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const appName = flagString(flags, "app-name");
  if (!appName) throw new CliUsageError("--app-name is required");
  const paths = parsePaths(flagString(flags, "paths") ?? "");
  if (paths.length === 0) {
    throw new CliUsageError("--paths is required (comma-separated)");
  }
  const body: CreateManifestBody = {
    appName,
    paths,
    hostId: flagString(flags, "host") ?? "_global",
  };
  const excludes = flagString(flags, "excludes");
  if (excludes) body.excludes = parsePaths(excludes);
  const schedule = flagString(flags, "schedule");
  if (schedule) body.schedule = schedule;
  const instructions = flagString(flags, "instructions");
  if (instructions) body.instructions = instructions;

  let manifest: DotfileManifest;
  try {
    manifest = await client.client.createDotfileManifest(body as Omit<DotfileManifest, "id">);
  } catch (err) {
    throw wrapApiError(err, "dotfiles manifests create");
  }
  if (json) {
    printJson(manifest);
    return;
  }
  console.log(`created manifest ${manifest.id} (${manifest.appName})`);
}

export async function runManifestDelete(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("dotfiles manifests delete <id> requires an id");
  }
  await confirmDestructive(ctx, {
    promptMessage: `delete dotfile manifest ${id} (and cascade its versions)`,
    flagNameYes: "yes",
  });
  try {
    await client.client.deleteDotfileManifest(id);
  } catch (err) {
    throw wrapApiError(err, "dotfiles manifests delete");
  }
  if (json) {
    printJson({ ok: true, id });
    return;
  }
  console.log(`deleted manifest ${id}`);
}

export async function runUpload(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const appName = flagString(flags, "app");
  if (!appName) throw new CliUsageError("--app <name> is required");
  const filePath = flagString(flags, "file");
  if (!filePath) throw new CliUsageError("--file <path> is required (tarball)");
  if (!existsSync(filePath)) {
    throw new CliUsageError(`file not found: ${filePath}`);
  }
  const fileStat = await stat(filePath);
  // Bun.file() streams the tarball without slurping the entire tarball into
  // a Blob via arrayBuffer — multipart uploads of multi-megabyte dotfiles
  // stay cheap. The returned Blob matches what `uploadDotfile` accepts.
  const bunFile = Bun.file(filePath);
  const blob = new Blob([bunFile], { type: "application/gzip" });
  void fileStat;
  const description = flagString(flags, "description");
  const hostId = flagString(flags, "host");
  let version: DotfileVersion;
  try {
    version = await client.client.uploadDotfile(
      appName,
      blob,
      {
        ...(description ? { description } : {}),
        ...(hostId ? { hostId } : {}),
      },
    );
  } catch (err) {
    throw wrapApiError(err, "dotfiles upload");
  }
  if (json) {
    printJson(version);
    return;
  }
  console.log(`uploaded version ${version.id} for ${appName}`);
}

export async function runDownload(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const appName = flagString(flags, "app") ?? parsed.rest[0];
  const version = flagString(flags, "version") ?? parsed.rest[1];
  if (!appName || !version) {
    throw new CliUsageError(
      "dotfiles download --app <name> --version <id> (or positional <appName> <versionId>)",
    );
  }
  const out = flagString(flags, "out");
  if (!out && !json) {
    throw new CliUsageError(
      "dotfiles download requires --out <path> (use --json for the raw bytes metadata)",
    );
  }
  let blob: Blob;
  try {
    blob = await client.client.downloadDotfile(appName, version);
  } catch (err) {
    throw wrapApiError(err, "dotfiles download");
  }
  if (json) {
    printJson({ ok: true, size: blob.size, type: blob.type });
    return;
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  if (out) writeFileSync(out, buf);
  else process.stdout.write(buf);
  if (out) console.log(`wrote ${buf.length} bytes to ${out}`);
}

function parsePaths(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
