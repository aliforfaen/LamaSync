/**
 * `lamasync folders list|create|assign`.
 *
 *   - `list`   → GET /folders, table or JSON.
 *   - `create` → POST /backends (when inline creds are given) + POST /folders.
 *                The CLI hides the two-step shape of LAMA-222: an agent that
 *                says `--backend s3 --s3-bucket foo --s3-endpoint … --s3-access-key-id …
 *                --s3-secret-access-key … --s3-region … --s3-provider …` gets one
 *                folder out the other side, not a "first create a backend" lecture.
 *                Backends are reused only by name; the CLI surfaces the new
 *                backend's id in --json output so subsequent folds can pin to it.
 *   - `assign` → POST /folders/:id/assign with `{hostId, localPath, role, ...}`.
 */

import { randomUUID } from "crypto";
import type {
  Backend,
  Folder,
  FolderAssignment,
  FolderBackend,
  FolderType,
} from "@lamasync/core";

import { CliUsageError, requireFlagString, flagBool, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson, printTable } from "./output.ts";

const FOLDER_TYPES: FolderType[] = ["sync", "mount", "backup", "dotfile", "git"];
const FOLDER_BACKENDS: FolderBackend[] = ["sftp", "s3", "local", "nfs", "restic"];

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let folders: Folder[];
  try {
    folders = await client.client.listFolders();
  } catch (err) {
    throw wrapApiError(err, "list folders");
  }
  if (json) {
    printJson(folders);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "TYPE", key: "type" },
      { header: "BACKEND", key: "backend" },
      { header: "S3 BUCKET", key: "s3Bucket" },
      { header: "BACKEND ID", key: "backendId" },
      { header: "ID", key: "id" },
    ],
    folders.map((f: Folder) => ({
      name: f.name,
      type: f.type,
      backend: f.backend ?? "sftp",
      s3Bucket: f.s3Bucket ?? "",
      backendId: f.backendId ?? "",
      id: f.id,
    })),
  );
}

export async function runCreate(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const name = requireFlagString(flags, "name");
  const type = requireFlagString(flags, "type");
  if (!FOLDER_TYPES.includes(type as FolderType)) {
    throw new CliUsageError(
      `invalid --type '${type}'; expected one of: ${FOLDER_TYPES.join(", ")}`,
    );
  }
  const backendRaw = flagString(flags, "backend");
  const backend = (backendRaw ?? "sftp") as FolderBackend;
  if (!FOLDER_BACKENDS.includes(backend)) {
    throw new CliUsageError(
      `invalid --backend '${backend}'; expected one of: ${FOLDER_BACKENDS.join(", ")}`,
    );
  }

  // Resolve the final backendId + (for s3) s3Bucket. Two paths:
  //   - inline creds (--s3-endpoint + --s3-access-key-id + --s3-secret-access-key): create a Backend row.
  //   - reference an existing row via --s3-backend-id / --backend-id.
  let backendId: string | null = null;
  let s3Bucket: string | null = null;

  if (backend === "s3") {
    s3Bucket = flagString(flags, "s3-bucket") ?? "";
    if (s3Bucket === "") {
      throw new CliUsageError(
        "folders create --backend s3 requires --s3-bucket <name>",
      );
    }
    const explicitRef = flagString(flags, "s3-backend-id");
    if (explicitRef) {
      backendId = explicitRef;
    } else {
      // Inline S3 creds → create a one-shot backend row.
      const endpoint = flagString(flags, "s3-endpoint");
      const accessKeyId = flagString(flags, "s3-access-key-id");
      const secretAccessKey = flagString(flags, "s3-secret-access-key");
      if (!endpoint || !accessKeyId || !secretAccessKey) {
        throw new CliUsageError(
          "folders create --backend s3 requires either --s3-backend-id or " +
            "--s3-endpoint + --s3-access-key-id + --s3-secret-access-key " +
            "(--s3-region required for --s3-provider=aws).",
        );
      }
      const region = flagString(flags, "s3-region") ?? null;
      const providerRaw = flagString(flags, "s3-provider");
      const provider =
        providerRaw === "exoscale" || providerRaw === "aws" || providerRaw === "b2" || providerRaw === "other"
          ? providerRaw
          : "other";
      // Backend name: the folder name; uniquified by suffix when a row
      // already uses the same label.
      const backendName = await ensureUniqueBackendName(client, `${name} (S3)`);
      let created: Backend;
      try {
        created = await client.client.createBackend({
          name: backendName,
          kind: "s3",
          s3Provider: provider,
          s3Endpoint: endpoint,
          s3Region: region ?? undefined,
          s3AccessKeyId: accessKeyId,
          s3SecretAccessKey: secretAccessKey,
        });
      } catch (err) {
        throw wrapApiError(err, "create backend");
      }
      backendId = created.id;
    }
  } else if (backend === "local" || backend === "nfs" || backend === "restic") {
    backendId = flagString(flags, "backend-id") ?? null;
    if (!backendId) {
      throw new CliUsageError(
        `folders create --backend ${backend} requires --backend-id <id>`,
      );
    }
  }

  const folderBody: Omit<Folder, "id"> = {
    name,
    type: type as FolderType,
    backend,
    backendId,
    s3Bucket,
    gitProvider: flagString(flags, "git-provider") === "gh"
      ? "gh"
      : flagString(flags, "git-provider") === "git"
        ? "git"
        : null,
    gitRemote: flagString(flags, "git-remote") ?? null,
  };

  let folder: Folder;
  try {
    folder = await client.client.createFolder(folderBody);
  } catch (err) {
    throw wrapApiError(err, "create folder");
  }

  if (json) {
    printJson({ folder, backendId });
    return;
  }
  console.log(`created folder ${folder.id} (${folder.name})`);
  if (backendId) {
    console.log(`backendId: ${backendId}`);
  }
}

export async function runAssign(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const folderId = parsed.rest[0] ?? "";
  if (!folderId) {
    throw new CliUsageError(
      "folders assign <folderId> requires a folder id as the first positional",
    );
  }
  const hostId = requireFlagString(flags, "host");
  const localPath = requireFlagString(flags, "path");
  if (localPath.length === 0 || !localPath.startsWith("/")) {
    throw new CliUsageError(
      `--path must be a non-empty absolute path (got: '${localPath}')`,
    );
  }
  const roleRaw = flagString(flags, "role");
  const role = roleRaw && ["source", "target", "both"].includes(roleRaw)
    ? roleRaw
    : "both";
  const schedule = flagString(flags, "schedule") ?? null;
  const destination = flagString(flags, "destination") ?? null;
  // --enabled / --disabled both flip the boolean; default behavior is enabled
  // unless --disabled is set explicitly.
  const explicitDisabled = flagBool(flags, "disabled");
  const explicitEnabled = flagBool(flags, "enabled");
  if (explicitDisabled && explicitEnabled) {
    throw new CliUsageError(
      "--enabled and --disabled are mutually exclusive",
    );
  }
  const enabled = explicitDisabled ? false : true;

  const body: Omit<FolderAssignment, "id"> = {
    folderId,
    hostId,
    role,
    localPath,
    remoteName: null,
    destination,
    syncExpr: schedule,
    enabled,
  };

  let assignment: FolderAssignment;
  try {
    assignment = await client.client.assignFolder(folderId, body);
  } catch (err) {
    throw wrapApiError(err, "assign folder");
  }

  if (json) {
    printJson(assignment);
    return;
  }
  console.log(`assigned ${folderId} → ${hostId} at ${localPath}`);
  if (schedule) {
    console.log(`schedule: ${schedule}`);
  }
}

async function ensureUniqueBackendName(
  client: CliContext["client"],
  base: string,
): Promise<string> {
  // Cheap uniqueness for inline-creates: if the desired name is taken, append
  // a short suffix. Backend names are user-facing labels; collision only
  // matters here because users may run the command twice.
  let existing: Backend[];
  try {
    existing = await client.client.listBackends();
  } catch (err) {
    throw wrapApiError(err, "list backends");
  }
  const taken = new Set(existing.map((b) => b.name));
  if (!taken.has(base)) return base;
  // Two attempts is enough: a UUID6 suffix almost never collides.
  for (let i = 0; i < 8; i++) {
    const candidate = `${base} ${randomUUID().slice(0, 6)}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}
