/**
 * `lamasync apps` (LAMA-316) — the canonical namespace for the app
 * backup contract: ApplicationTemplate → ApplicationProtection (bound to
 * exactly one host) → ApplicationSnapshot (immutable archive metadata).
 *
 * Templates are operator-owned recipes (admin-only on the server);
 * enrolling binds a template to a host with a captured copy of its
 * capture spec; snapshots are uploaded/downloaded under a protection.
 * The multipart upload takes a local tarball path the operator can read;
 * downloads write to `--out <path>` (or report byte metadata with
 * `--json`).
 */

import { existsSync, writeFileSync } from "fs";
import { stat } from "fs/promises";

import type {
  ApplicationProtection,
  ApplicationProtectionListItem,
  ApplicationSnapshot,
  ApplicationTemplate,
  CaptureSpec,
  CaptureSpecPath,
} from "@lamasync/core";

import { CliUsageError, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function runTemplatesList(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let templates: ApplicationTemplate[];
  try {
    templates = await client.client.listAppTemplates();
  } catch (err) {
    throw wrapApiError(err, "apps templates list");
  }
  if (json) {
    printJson(templates);
    return;
  }
  printTable(
    [
      { header: "TEMPLATE", key: "name" },
      { header: "ORIGIN", key: "origin" },
      { header: "REV", key: "revision" },
      { header: "LINUX", key: "linuxLabel" },
      { header: "MACOS", key: "macosLabel" },
      { header: "WINDOWS", key: "windowsLabel" },
      { header: "ID", key: "id" },
    ],
    templates.map((t) => ({
      name: t.name,
      origin: t.origin,
      revision: t.revision,
      linuxLabel: countLabel(t.paths.paths.linux?.length ?? 0),
      macosLabel: countLabel(t.paths.paths.macos?.length ?? 0),
      windowsLabel: countLabel(t.paths.paths.windows?.length ?? 0),
      id: t.id,
    })),
  );
}

export async function runTemplateGet(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps templates get <id> requires an id");
  }
  let template: ApplicationTemplate;
  try {
    template = await client.client.getAppTemplate(id);
  } catch (err) {
    throw wrapApiError(err, "apps templates get");
  }
  if (json) {
    printJson(template);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "ORIGIN", key: "origin" },
      { header: "REV", key: "revision" },
      { header: "DESCRIPTION", key: "description" },
      { header: "PATHS", key: "pathsLabel" },
      { header: "ID", key: "id" },
    ],
    [
      {
        name: template.name,
        origin: template.origin,
        revision: template.revision,
        description: template.description ?? "",
        pathsLabel: describeTemplatePaths(template.paths),
        id: template.id,
      },
    ],
  );
}

type TemplateBody = Omit<
  ApplicationTemplate,
  "id" | "createdAt" | "updatedAt" | "revision"
>;

export async function runTemplateCreate(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const name = flagString(flags, "name");
  if (!name) throw new CliUsageError("--name is required");
  const origin = flagString(flags, "origin");
  if (origin && origin !== "built_in" && origin !== "custom") {
    throw new CliUsageError("--origin must be built_in or custom");
  }
  const spec = captureSpecFromFlags(flags) ?? {
    paths: {},
    excludes: [],
    notes: null,
  };
  const body: TemplateBody = {
    name,
    origin: origin === "built_in" ? "built_in" : "custom",
    description: flagString(flags, "description") ?? null,
    emoji: flagString(flags, "emoji") ?? null,
    color: flagString(flags, "color") ?? null,
    paths: spec,
    installUrl: flagString(flags, "install-url") ?? null,
    installInstructions: flagString(flags, "install-instructions") ?? null,
    restoreInstructions: flagString(flags, "restore-instructions") ?? null,
  };
  let template: ApplicationTemplate;
  try {
    template = await client.client.createAppTemplate(body);
  } catch (err) {
    throw wrapApiError(err, "apps templates create");
  }
  if (json) {
    printJson(template);
    return;
  }
  console.log(`created template ${template.name} (${template.id})`);
}

export async function runTemplateUpdate(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps templates update <id> requires an id");
  }
  const body: Partial<TemplateBody> = {};
  const name = flagString(flags, "name");
  if (name) body.name = name;
  const origin = flagString(flags, "origin");
  if (origin) {
    if (origin !== "built_in" && origin !== "custom") {
      throw new CliUsageError("--origin must be built_in or custom");
    }
    body.origin = origin === "built_in" ? "built_in" : "custom";
  }
  const description = flagString(flags, "description");
  if (description !== undefined) body.description = description;
  const emoji = flagString(flags, "emoji");
  if (emoji !== undefined) body.emoji = emoji;
  const color = flagString(flags, "color");
  if (color !== undefined) body.color = color;
  const spec = captureSpecFromFlags(flags);
  if (spec) body.paths = spec;
  const installUrl = flagString(flags, "install-url");
  if (installUrl !== undefined) body.installUrl = installUrl;
  const installInstructions = flagString(flags, "install-instructions");
  if (installInstructions !== undefined) body.installInstructions = installInstructions;
  const restoreInstructions = flagString(flags, "restore-instructions");
  if (restoreInstructions !== undefined) body.restoreInstructions = restoreInstructions;
  if (Object.keys(body).length === 0) {
    throw new CliUsageError(
      "apps templates update requires at least one flag to change",
    );
  }
  let template: ApplicationTemplate;
  try {
    template = await client.client.updateAppTemplate(id, body);
  } catch (err) {
    throw wrapApiError(err, "apps templates update");
  }
  if (json) {
    printJson(template);
    return;
  }
  console.log(`updated template ${template.name} (revision ${template.revision})`);
}

export async function runTemplateDelete(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps templates delete <id> requires an id");
  }
  // Deleting a template 409s server-side while protections exist; the
  // confirm exists so operators state intent before that check runs.
  await confirmDestructive(ctx, {
    promptMessage: `delete app template ${id} (fails while protections use it)`,
    flagNameYes: "yes",
  });
  try {
    await client.client.deleteAppTemplate(id);
  } catch (err) {
    throw wrapApiError(err, "apps templates delete");
  }
  if (json) {
    printJson({ ok: true, id });
    return;
  }
  console.log(`deleted template ${id}`);
}

// ---------------------------------------------------------------------------
// Protections
// ---------------------------------------------------------------------------

export async function runProtectionsList(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const host = flagString(flags, "host");
  let protections: ApplicationProtectionListItem[];
  try {
    protections = await client.client.listAppProtections(host ?? undefined);
  } catch (err) {
    throw wrapApiError(err, "apps protections list");
  }
  if (json) {
    printJson(protections);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "TEMPLATE", key: "templateLabel" },
      { header: "HOST", key: "hostId" },
      { header: "ENABLED", key: "enabled" },
      { header: "SCHEDULE", key: "schedule" },
      { header: "LATEST", key: "latestLabel" },
      { header: "ID", key: "id" },
    ],
    protections.map((p) => ({
      name: p.name,
      templateLabel: p.templateEmoji
        ? `${p.templateEmoji} ${p.templateName}`
        : p.templateName,
      hostId: p.hostId,
      enabled: p.enabled ? "yes" : "no",
      schedule: p.schedule ?? "",
      latestLabel: p.latestSnapshot
        ? new Date(p.latestSnapshot.createdAt).toISOString()
        : "—",
      id: p.id,
    })),
  );
}

export async function runProtectionGet(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps protections get <id> requires an id");
  }
  let protection: ApplicationProtection;
  try {
    protection = await client.client.getAppProtection(id);
  } catch (err) {
    throw wrapApiError(err, "apps protections get");
  }
  if (json) {
    printJson(protection);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "TEMPLATE", key: "templateId" },
      { header: "TEMPLATE REV", key: "templateRevision" },
      { header: "HOST", key: "hostId" },
      { header: "ENABLED", key: "enabled" },
      { header: "SCHEDULE", key: "schedule" },
      { header: "DESTINATION", key: "destination" },
      { header: "PATHS", key: "pathsLabel" },
      { header: "ID", key: "id" },
    ],
    [
      {
        name: protection.name,
        templateId: protection.templateId,
        templateRevision: protection.templateRevision,
        hostId: protection.hostId,
        enabled: protection.enabled ? "yes" : "no",
        schedule: protection.schedule ?? "",
        destination: protection.destination,
        pathsLabel: describeTemplatePaths(protection.captureSpec),
        id: protection.id,
      },
    ],
  );
}

export async function runProtectionEnroll(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const templateId = flagString(flags, "template");
  if (!templateId) {
    throw new CliUsageError("--template <id> is required");
  }
  const hostId = flagString(flags, "host");
  if (!hostId) {
    throw new CliUsageError("--host <hostId> is required");
  }
  const schedule = flagString(flags, "schedule");
  const name = flagString(flags, "name");
  let protection: ApplicationProtection;
  try {
    protection = await client.client.enrollAppProtection({
      templateId,
      hostId,
      ...(schedule ? { schedule } : {}),
      ...(name ? { name } : {}),
    });
  } catch (err) {
    throw wrapApiError(err, "apps protections enroll");
  }
  if (json) {
    printJson(protection);
    return;
  }
  console.log(
    `enrolled protection ${protection.name} (${protection.id}) for host ${hostId}`,
  );
}

export async function runProtectionUpdate(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps protections update <id> requires an id");
  }
  const body: Partial<
    Pick<ApplicationProtection, "name" | "enabled" | "schedule" | "destination">
  > = {};
  const enabledRaw = flagString(flags, "enabled");
  if (enabledRaw !== undefined) {
    if (enabledRaw !== "true" && enabledRaw !== "false") {
      throw new CliUsageError("--enabled expects true or false");
    }
    body.enabled = enabledRaw === "true";
  }
  const schedule = flagString(flags, "schedule");
  if (schedule !== undefined) body.schedule = schedule;
  const name = flagString(flags, "name");
  if (name !== undefined) body.name = name;
  if (Object.keys(body).length === 0) {
    throw new CliUsageError(
      "apps protections update requires at least one of --enabled, --schedule, --name",
    );
  }
  let protection: ApplicationProtection;
  try {
    protection = await client.client.updateAppProtection(id, body);
  } catch (err) {
    throw wrapApiError(err, "apps protections update");
  }
  if (json) {
    printJson(protection);
    return;
  }
  console.log(
    `updated protection ${protection.name} (${protection.id})` +
      (body.enabled !== undefined ? ` — enabled: ${body.enabled}` : ""),
  );
}

export async function runProtectionDelete(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps protections delete <id> requires an id");
  }
  await confirmDestructive(ctx, {
    promptMessage: `delete empty app protection ${id} (protections with snapshots must be disabled instead)`,
    flagNameYes: "yes",
  });
  try {
    await client.client.deleteAppProtection(id);
  } catch (err) {
    throw wrapApiError(err, "apps protections delete");
  }
  if (json) {
    printJson({ ok: true, id });
    return;
  }
  console.log(`deleted protection ${id}`);
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export async function runSnapshotsList(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const protectionId = flagString(flags, "protection");
  if (!protectionId) {
    throw new CliUsageError("--protection <id> is required");
  }
  let snapshots: ApplicationSnapshot[];
  try {
    snapshots = await client.client.listAppSnapshots(protectionId);
  } catch (err) {
    throw wrapApiError(err, "apps snapshots list");
  }
  if (json) {
    printJson(snapshots);
    return;
  }
  printTable(
    [
      { header: "TIMESTAMP", key: "timestampLabel" },
      { header: "SIZE", key: "sizeLabel" },
      { header: "INTEGRITY", key: "integrityStatus" },
      { header: "CHECKSUM", key: "checksumLabel" },
      { header: "DESCRIPTION", key: "description" },
      { header: "ID", key: "id" },
    ],
    snapshots.map((s) => ({
      timestampLabel: new Date(s.createdAt).toISOString(),
      sizeLabel: s.sizeBytes === null ? "—" : `${s.sizeBytes} B`,
      integrityStatus: s.integrityStatus,
      checksumLabel: s.checksumSha256 ? s.checksumSha256.slice(0, 16) : "—",
      description: s.description ?? "",
      id: s.id,
    })),
  );
}

export async function runSnapshotUpload(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const protectionId = flagString(flags, "protection");
  if (!protectionId) {
    throw new CliUsageError("--protection <id> is required");
  }
  const filePath = flagString(flags, "file");
  if (!filePath) {
    throw new CliUsageError("--file <path> is required (tarball)");
  }
  if (!existsSync(filePath)) {
    throw new CliUsageError(`file not found: ${filePath}`);
  }
  const fileStat = await stat(filePath);
  // Bun.file() streams the tarball without slurping it into memory — the
  // multipart upload of multi-megabyte app archives stays cheap. The
  // returned Blob matches what `uploadAppSnapshot` accepts.
  const bunFile = Bun.file(filePath);
  const blob = new Blob([bunFile], { type: "application/gzip" });
  void fileStat;
  const description = flagString(flags, "description");
  let snapshot: ApplicationSnapshot;
  try {
    snapshot = await client.client.uploadAppSnapshot(
      protectionId,
      blob,
      description ? { description } : {},
    );
  } catch (err) {
    throw wrapApiError(err, "apps snapshots upload");
  }
  if (json) {
    printJson(snapshot);
    return;
  }
  console.log(`uploaded snapshot ${snapshot.id} for protection ${protectionId}`);
}

export async function runSnapshotDownload(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const snapshotId = flagString(flags, "snapshot") ?? parsed.rest[0];
  if (!snapshotId) {
    throw new CliUsageError(
      "apps snapshots download --snapshot <id> (or positional <snapshotId>)",
    );
  }
  const out = flagString(flags, "out");
  if (!out && !json) {
    throw new CliUsageError(
      "apps snapshots download requires --out <path> (use --json for the raw bytes metadata)",
    );
  }
  let blob: Blob;
  try {
    blob = await client.client.downloadAppSnapshot(snapshotId);
  } catch (err) {
    throw wrapApiError(err, "apps snapshots download");
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

export async function runSnapshotDelete(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) {
    throw new CliUsageError("apps snapshots delete <id> requires an id");
  }
  await confirmDestructive(ctx, {
    promptMessage: `delete app snapshot ${id} (archive file is removed)`,
    flagNameYes: "yes",
  });
  try {
    await client.client.deleteAppSnapshot(id);
  } catch (err) {
    throw wrapApiError(err, "apps snapshots delete");
  }
  if (json) {
    printJson({ ok: true, id });
    return;
  }
  console.log(`deleted snapshot ${id}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a comma-separated path list, dropping empties. */
function parseCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build a CaptureSpec from the per-OS `--*-paths` flags; undefined when
 *  no path flag was given (used by template update to leave paths alone). */
function captureSpecFromFlags(
  flags: CliContext["flags"],
): CaptureSpec | undefined {
  const linux = parseCsv(flagString(flags, "linux-paths"));
  const macos = parseCsv(flagString(flags, "macos-paths"));
  const windows = parseCsv(flagString(flags, "windows-paths"));
  if (linux.length === 0 && macos.length === 0 && windows.length === 0) {
    return undefined;
  }
  const bucket = (paths: string[]): CaptureSpecPath[] =>
    paths.map((path) => ({ path, classification: "unknown" as const }));
  return {
    paths: {
      ...(linux.length > 0 ? { linux: bucket(linux) } : {}),
      ...(macos.length > 0 ? { macos: bucket(macos) } : {}),
      ...(windows.length > 0 ? { windows: bucket(windows) } : {}),
    },
    excludes: [],
    notes: null,
  };
}

function countLabel(n: number): string {
  return n > 0 ? String(n) : "";
}

/** Short per-OS path summary for table cells: "linux:2 macos:1". */
function describeTemplatePaths(spec: CaptureSpec): string {
  const parts: string[] = [];
  const push = (os: string, paths: CaptureSpecPath[] | undefined): void => {
    if (paths && paths.length > 0) parts.push(`${os}:${paths.length}`);
  };
  push("linux", spec.paths.linux);
  push("macos", spec.paths.macos);
  push("windows", spec.paths.windows);
  return parts.length > 0 ? parts.join(" ") : "(no paths)";
}
