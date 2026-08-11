/**
 * `lamasync folders update|delete|unassign|assignments` (LAMA-231).
 *
 * Inherits every Phase A convention (--json, exit codes, mask). The two
 * destructive commands (`folders delete`, `folders unassign`) honour
 * safety rule 5: prompt on a TTY, require `--yes` non-interactively.
 */

import type { Folder, FolderAssignment } from "@lamasync/core";

import { CliUsageError, flagBool, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";
import { confirmDestructive } from "./safety.ts";

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
      { header: "ENABLED", key: "enabled" },
      { header: "ID", key: "id" },
    ],
    assignments.map((a: FolderAssignment) => ({
      hostId: a.hostId,
      role: a.role,
      localPath: a.localPath,
      syncExpr: a.syncExpr ?? "",
      enabled: a.enabled ? "yes" : "no",
      id: a.id,
    })),
  );
}
