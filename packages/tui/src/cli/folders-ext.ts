/**
 * `lamasync folders update|delete|unassign|assignments` (LAMA-231).
 *
 * Inherits every Phase A convention (--json, exit codes, mask). The two
 * destructive commands (`folders delete`, `folders unassign`) honour
 * safety rule 5: prompt on a TTY, require `--yes` non-interactively.
 */

import type { Folder, FolderAssignment } from "@lamasync/core";
import { resolveWatchQuietSec } from "@lamasync/core";

import { CliUsageError, flagBool, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";
import { watchFlagsToBody } from "./folders.ts";

export async function runUpdate(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) throw new CliUsageError("folders update <folderId> requires an id");

  // Pass-through body builder. We send only the fields the operator set
  // — anything left out preserves the existing value server-side.
  const body: Record<string, unknown> = {};
  const name = flagString(flags, "name");
  if (name) body.name = name;
  const type = flagString(flags, "type");
  if (type) body.type = type;
  const backend = flagString(flags, "backend");
  if (backend) body.backend = backend;
  const backendId = flagString(flags, "backend-id") ?? flagString(flags, "s3-backend-id");
  if (backendId) body.backendId = backendId;
  const s3Bucket = flagString(flags, "s3-bucket");
  if (s3Bucket) body.s3Bucket = s3Bucket;
  const encrypted = flagBool(flags, "encrypted");
  if (encrypted) body.encrypted = true;
  const gitProvider = flagString(flags, "git-provider");
  if (gitProvider) body.gitProvider = gitProvider;
  const gitRemote = flagString(flags, "git-remote");
  if (gitRemote) body.gitRemote = gitRemote;

  if (Object.keys(body).length === 0) {
    throw new CliUsageError(
      "folders update requires at least one of --name/--type/--backend/--backend-id/--s3-bucket/--encrypted/--git-provider/--git-remote",
    );
  }

  let folder: Folder;
  try {
    folder = await client.client.updateFolder(id, body as Partial<Folder>);
  } catch (err) {
    throw wrapApiError(err, "update folder");
  }
  if (json) {
    printJson(folder);
    return;
  }
  console.log(`updated folder ${folder.id} (${folder.name})`);
}

export async function runDelete(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const id = parsed.rest[0];
  if (!id) throw new CliUsageError("folders delete <folderId> requires an id");
  await confirmDestructive(ctx, {
    promptMessage: `delete folder ${id} (cascades to assignments, snapshots, manifests)`,
    detailsUrl: "https://github.com/aliforfaen/LamaSync/blob/master/packages/agent-skill/reference/safety.md",
    flagNameYes: "yes",
  });

  try {
    await client.client.deleteFolder(id);
  } catch (err) {
    throw wrapApiError(err, "delete folder");
  }
  if (json) {
    printJson({ ok: true, id });
    return;
  }
  console.log(`deleted folder ${id}`);
}

export async function runUnassign(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const folderId = parsed.rest[0];
  const hostId = flagString(flags, "host");
  if (!folderId || !hostId) {
    throw new CliUsageError(
      "folders unassign <folderId> --host <hostId> requires both",
    );
  }
  await confirmDestructive(ctx, {
    promptMessage: `remove assignment of ${folderId} on host ${hostId}`,
    detailsUrl: "https://github.com/aliforfaen/LamaSync/blob/master/packages/agent-skill/reference/safety.md",
    flagNameYes: "yes",
  });

  try {
    await client.client.unassignFolder(folderId, hostId);
  } catch (err) {
    throw wrapApiError(err, "unassign folder");
  }
  if (json) {
    printJson({ ok: true, folderId, hostId });
    return;
  }
  console.log(`unassigned ${folderId} from ${hostId}`);
}

// LAMA-302: update an existing assignment's watch settings (and any other
// pass-through field the operator sets). Addressed by folder+host, matching
// the server's PATCH /folders/:folderId/assign/:hostId.
export async function runAssignmentUpdate(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const folderId = parsed.rest[0];
  if (!folderId) {
    throw new CliUsageError(
      "folders assign-update <folderId> requires a folder id as the first positional",
    );
  }
  const hostId = flagString(flags, "host");
  if (!hostId) {
    throw new CliUsageError("folders assign-update requires --host <hostId>");
  }

  const body: Partial<FolderAssignment> = {};
  const schedule = flagString(flags, "schedule");
  if (schedule !== undefined) body.syncExpr = schedule;
  const watchBody = watchFlagsToBody(flags);
  if (watchBody) Object.assign(body, watchBody);

  if (Object.keys(body).length === 0) {
    throw new CliUsageError(
      "folders assign-update requires at least one of --watch/--no-watch/--watch-quiet/--ignore-git-metadata/--respect-gitignore/--schedule",
    );
  }

  let assignment: FolderAssignment;
  try {
    assignment = await client.client.updateAssignment(folderId, hostId, body);
  } catch (err) {
    throw wrapApiError(err, "update assignment");
  }
  if (json) {
    printJson(assignment);
    return;
  }
  console.log(`updated assignment ${folderId} → ${hostId}`);
  if (assignment.watchEnabled) {
    console.log(
      `sync after local changes: yes (wait ${resolveWatchQuietSec(assignment.watchQuietSec)}s)`,
    );
  } else {
    console.log("sync after local changes: no");
  }
}

export async function runAssignments(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const folderId = parsed.rest[0];
  if (!folderId) {
    throw new CliUsageError(
      "folders assignments <folderId> requires a folder id",
    );
  }
  let assignments: FolderAssignment[];
  try {
    assignments = await client.client.listFolderAssignments(folderId);
  } catch (err) {
    throw wrapApiError(err, "list assignments");
  }
  if (json) {
    printJson(assignments);
    return;
  }
  printTable(
    [
      { header: "HOST", key: "hostId" },
      { header: "ROLE", key: "role" },
      { header: "PATH", key: "localPath" },
      { header: "SCHEDULE", key: "syncExpr" },
      { header: "WATCH", key: "watch" },
      { header: "ENABLED", key: "enabled" },
      { header: "ID", key: "id" },
    ],
    assignments.map((a: FolderAssignment) => ({
      hostId: a.hostId,
      role: a.role,
      localPath: a.localPath,
      syncExpr: a.syncExpr ?? "",
      watch: a.watchEnabled ? `yes (${resolveWatchQuietSec(a.watchQuietSec)}s)` : "no",
      enabled: a.enabled ? "yes" : "no",
      id: a.id,
    })),
  );
}
