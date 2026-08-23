/**
 * CLI dispatcher for `lamasync <command> [...args]`.
 *
 * Routing (LAMA-229 conventions):
 *   - `lamasync --help` / `lamasync -h`        → top-level help.
 *   - `lamasync <cmd> --help` / `-h`            → command-specific help.
 *   - `lamasync <cmd1> <cmd2> [--json]`         → dispatched by command name.
 *
 * Every command module implements `CliCommand` (run + help). The dispatcher
 * catches `CliUsageError` (exit 2) and re-throws other errors so the
 * top-level `main()` can map them to the right exit code.
 */

import {
  CliUsageError,
  type ParsedArgs,
  flagBool,
  flagString,
  parseArgs,
  wantJson,
} from "./args.ts";
import {
  buildCliClient,
  exitCodeForError,
  type CliClient,
} from "./client.ts";
import { maskSecret } from "./output.ts";

import * as status from "./status.ts";
import * as folders from "./folders.ts";
import * as foldersExt from "./folders-ext.ts";
import * as backends from "./backends.ts";
import * as sync from "./sync.ts";
import * as ops from "./ops.ts";
import * as doctor from "./doctor.ts";
import * as local from "./local.ts";
import * as dotfiles from "./dotfiles.ts";
import * as conflicts from "./conflicts.ts";
import * as snapshots from "./snapshots.ts";
import * as browse from "./browse.ts";
import * as notifications from "./notifications.ts";
import * as hosts from "./hosts.ts";
import * as admin from "./admin.ts";

export interface CliContext {
  parsed: ParsedArgs;
  flags: ParsedArgs["flags"];
  client: CliClient;
  json: boolean;
}

export interface CliCommandModule {
  /** Module key inside its parent command's dispatcher (e.g. "list"). */
  key?: string;
  help: { summary: string; usage: string };
  run(ctx: CliContext): Promise<void> | void;
}

interface DispatchEntry {
  /** Module key inside its parent command's dispatcher (e.g. "list"). */
  key?: string;
  /** Subcommands surfaced under this node. Empty/missing = leaf. May
   *  itself contain nested groups (e.g. `dotfiles manifests create`). */
  subcommands?: Record<string, DispatchEntry>;
  /**
   * When set, this node is itself a command (leaf). Subcommand entries
   * use this directly when they have no nested subcommands; group entries
   * only need `help` + `subcommands`.
   */
  command?: CliCommandModule;
  /** Optional group-level help (for nodes that have subcommands but no run()). */
  help?: { summary: string; usage: string };
  /**
   * Leaf-level run() helper, present on entries defined inline in
   * `subcommands` maps. Equivalent to `command.run`; the walk normalizes
   * both shapes.
   */
  run?: CliCommandModule["run"];
}

/** Top-level help text. Each command module owns its own help. */
const TOP_HELP = {
  summary:
    "lamasync — manage a LamaSync fleet and the local daemon. Bare " +
    "`lamasync` (with a TTY) boots the TUI; any subcommand exits non-interactively.",
  usage: `Usage: lamasync <command> [args] [--json] [--server URL] [--api-key KEY]

Commands:
  status                  Fleet health + per-host status (LAMA-229)
  folders list            List folders
  folders create          Create a folder (--name, --type, ...)
  folders assign          Assign a folder to a device (--host, --path)
  folders update          Update an existing folder
  folders delete          Delete a folder (cascade; DESTRUCTIVE)
  folders unassign        Remove a folder's device assignment (DESTRUCTIVE)
  folders assignments     List a folder's device assignments
  backends list           List reusable storage destinations
  backends create         Create a storage destination (--name, --kind, ...)
  backends test           Test a storage destination by id
  sync [folderId]         Trigger a sync (--host, optional --folder)
  ops list                List recent activity (--status, --host, --folder, --limit)
  doctor                  Structured health report (env, server, socket, version)
  dotfiles list           List app settings backups (dotfile manifests)
  dotfiles manifests      CRUD over app settings backup manifests
  dotfiles upload         Upload a new app settings backup version
  dotfiles download       Download an app settings backup tarball
  conflicts list          List manual sync conflicts
  conflicts resolve       Resolve a conflict
  snapshots list          List restic snapshots
  restore                 Enqueue a restic restore job (DESTRUCTIVE)
  browse local            Browse the server backup dir
  browse s3               Browse an S3 folder's prefix
  browse restic           Browse restic snapshots
  browse jobs             Recent browse write jobs
  notifications list      List notification events
  notifications channels  List delivery channels
  notifications test      Send a test notification (--channel for one channel)
  hosts list              List registered devices
  hosts rename            Rename a device (DESTRUCTIVE)
  register                Register or update a device in the fleet
  shares list             List NFS / SMB shares
  admin prune             Manually prune operation_log (DESTRUCTIVE)
  local status            Local daemon status (Unix socket)
  local folders           List local folder assignments
  local ops               List local activity (operation log)
  local sync [folderId]   Trigger sync for one folder via the socket
  local sync-all          Trigger sync for every folder
  local mount <id>        Switch folder to mount mode
  local unmount <id>      Switch folder back to sync mode

Common flags:
  --json, -j              Machine-readable JSON output
  --server URL            Override the server URL
  --api-key KEY           Override the API key (also MASKED in any output)
  --help, -h              Show help for lamasync <command>

Exit codes (stable contract for the skill's drift check, LAMA-230):
  0 ok, 1 runtime error, 2 usage error,
  3 auth failure (401/403), 4 server unreachable

Run 'lamasync <command> --help' for command-specific help.`,
};

const DISPATCH_TREE: Record<string, DispatchEntry> = {
  status: {
    command: {
      help: statusHelp(),
      run: async (ctx) => status.run(ctx),
    },
  },
  folders: {
    help: groupHelp(
      "folders",
      "Manage sync / mount / backup / dotfile / git folders.",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp("folders list", "List folders.", ["--json"]),
        run: async (ctx) => folders.runList(ctx),
      },
      create: {
        key: "create",
        help: subHelp(
          "folders create",
          "Create a folder.",
          [
            "--name <name>           folder name (required)",
            "--type <type>           sync | mount | backup | dotfile | git (required)",
            "--backend <kind>        sftp | s3 | local | nfs | restic (default: sftp)",
            "  For s3:",
            "    --s3-backend-id <id>    reuse a stored S3 backend (LAMA-222)",
            "    --s3-bucket <bucket>    required when --backend=s3",
            "    --s3-provider <p>       exoscale | aws | other (default: other)",
            "    --s3-endpoint <url>     required when --backend=s3 (unless using backendId)",
            "    --s3-access-key-id <k>  S3 access key id",
            "    --s3-secret-access-key <s>  S3 secret (write-only; never echoed)",
            "    --s3-region <r>         region (e.g. us-east-1); required for aws",
            "  For local/nfs:",
            "    --backend-id <id>       reference a local/nfs backend row",
            "  For restic:",
            "    --backend-id <id>       reference a restic backend row",
          ],
        ),
        run: async (ctx) => folders.runCreate(ctx),
      },
      assign: {
        key: "assign",
        help: subHelp(
          "folders assign <folderId>",
          "Assign an existing folder to a device.",
          [
            "--host <hostId>        host id (required)",
            "--path <localPath>     absolute local path (required)",
            "--role <role>          source | target | both (default: both)",
            "--schedule <cron>      cron expression (optional)",
            "--enabled              mark the assignment enabled (default)",
            "--disabled             mark the assignment disabled",
          ],
        ),
        run: async (ctx) => folders.runAssign(ctx),
      },
      update: {
        key: "update",
        help: subHelp(
          "folders update <folderId>",
          "Update an existing folder (PATCH-style; only the flags you set are sent).",
          [
            "--name <name>           new name",
            "--type <type>           sync | mount | backup | dotfile | git",
            "--backend <kind>        sftp | s3 | local | nfs | restic",
            "--backend-id <id>       reference an existing Backend row",
            "--s3-bucket <bucket>    per-folder S3 bucket",
            "--s3-backend-id <id>    alias of --backend-id for S3 folders",
            "--git-provider <p>      git | gh",
            "--git-remote <remote>   <user>/<repo>",
            "--encrypted             enable at-rest encryption (LAMA-124)",
          ],
        ),
        run: async (ctx) => foldersExt.runUpdate(ctx),
      },
      delete: {
        key: "delete",
        help: subHelp(
          "folders delete <folderId>",
          "Delete a folder + cascade its device assignments (DESTRUCTIVE — safety rule 5).",
          [
            "--yes, -y           skip the confirmation prompt (required non-interactively)",
          ],
        ),
        run: async (ctx) => foldersExt.runDelete(ctx),
      },
      unassign: {
        key: "unassign",
        help: subHelp(
          "folders unassign <folderId> --host <hostId>",
          "Remove a folder's device assignment (DESTRUCTIVE — safety rule 5).",
          [
            "--host <hostId>    host id (required)",
            "--yes, -y          skip the confirmation prompt (required non-interactively)",
          ],
        ),
        run: async (ctx) => foldersExt.runUnassign(ctx),
      },
      assignments: {
        key: "assignments",
        help: subHelp(
          "folders assignments <folderId>",
          "List a folder's device assignments.",
          ["--json"],
        ),
        run: async (ctx) => foldersExt.runAssignments(ctx),
      },
    },
  },
  backends: {
    help: groupHelp(
      "backends",
      "Manage reusable S3 / local / nfs / restic backends.",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp("backends list", "List backends.", ["--json"]),
        run: async (ctx) => backends.runList(ctx),
      },
      create: {
        key: "create",
        help: subHelp(
          "backends create",
          "Create a reusable storage destination.",
          [
            "--name <name>            backend name (required)",
            "--kind <kind>            s3 | local | nfs | restic (required)",
            "  For s3:",
            "    --s3-provider <p>       exoscale | aws | other (default: other)",
            "    --s3-endpoint <url>     required",
            "    --s3-region <r>         required for aws",
            "    --s3-access-key-id <k>  required",
            "    --s3-secret-access-key <s>  required (write-only)",
            "  For local/nfs:",
            "    --local-path <dir>      absolute server-side directory (required)",
            "  For restic:",
            "    --restic-repository <u> required (e.g. sftp://host/repo or /mnt/repo)",
            "    --restic-password <pw>  required",
          ],
        ),
        run: async (ctx) => backends.runCreate(ctx),
      },
      test: {
        key: "test",
        help: subHelp(
          "backends test <backendId>",
          "Test a storage destination (POST /backends/:id/test).",
          ["--json"],
        ),
        run: async (ctx) => backends.runTest(ctx),
      },
    },
  },
  sync: {
    command: {
      help: syncHelp(),
      run: async (ctx) => sync.run(ctx),
    },
  },
  ops: {
    help: groupHelp("ops", "Browse the operation log."),
    subcommands: {
      list: {
        key: "list",
        help: subHelp(
          "ops list",
          "List recent activity (operation log).",
          [
            "--status <s>     filter by status (started|success|failed|conflict|recovery|retry)",
            "--host <id>      filter by host",
            "--folder <id>    filter by folder",
            "--limit <n>      max rows (default 50, max 500)",
            "--json           machine-readable output",
          ],
        ),
        run: async (ctx) => ops.runList(ctx),
      },
    },
  },
  doctor: {
    command: {
      help: doctorHelp(),
      run: async (ctx) => doctor.run(ctx),
    },
  },
  dotfiles: {
    help: groupHelp(
      "dotfiles",
      "Manage app settings backups (dotfile manifests).",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp(
          "dotfiles list",
          "List app settings backups (dotfile manifests; --host filters by device).",
          ["--host <id>", "--json"],
        ),
        run: async (ctx) => dotfiles.runList(ctx),
      },
      manifests: {
        help: groupHelp(
          "dotfiles manifests",
          "CRUD over /api/v1/dotfiles/manifests.",
        ),
        subcommands: {
          list: {
            key: "list",
            help: subHelp(
              "dotfiles manifests list",
              "List app settings backups (dotfile manifests; --host filters by device).",
              ["--host <id>", "--json"],
            ),
            run: async (ctx) => dotfiles.runManifestsList(ctx),
          },
          create: {
            key: "create",
            help: subHelp(
              "dotfiles manifests create",
              "Create an app settings backup manifest.",
              [
                "--app-name <name>        app name (required)",
                "--paths <p1,p2>          comma-separated paths (required)",
                "--host <id|_global>      target host (default: _global)",
                "--excludes <e1,e2>       comma-separated exclude globs",
                "--schedule '<cron>'      sync schedule",
                "--instructions '<text>'  operator notes",
                "--json",
              ],
            ),
            run: async (ctx) => dotfiles.runManifestCreate(ctx),
          },
          delete: {
            key: "delete",
            help: subHelp(
              "dotfiles manifests delete <id>",
              "Delete an app settings backup manifest and cascade its versions (DESTRUCTIVE — safety rule 5).",
              ["--yes, -y    skip the confirmation prompt (required non-interactively)"],
            ),
            run: async (ctx) => dotfiles.runManifestDelete(ctx),
          },
        },
      },
      upload: {
        key: "upload",
        help: subHelp(
          "dotfiles upload",
          "Upload a new dotfile tarball version.",
          [
            "--app <name>          app name (required)",
            "--file <tarball>      tarball file path (required)",
            "--description <text> optional label",
            "--host <id>           target host (omit for _global)",
          ],
        ),
        run: async (ctx) => dotfiles.runUpload(ctx),
      },
      download: {
        key: "download",
        help: subHelp(
          "dotfiles download",
          "Download a dotfile tarball (writes to --out).",
          [
            "--app <name>          app name",
            "--version <id>        version id",
            "--out <path>          output file path (required)",
          ],
        ),
        run: async (ctx) => dotfiles.runDownload(ctx),
      },
    },
  },
  conflicts: {
    help: groupHelp(
      "conflicts",
      "List and resolve manual sync conflicts.",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp(
          "conflicts list",
          "List conflicts (optional --host/--folder/--status filters).",
          ["--host <id>", "--folder <id>", "--status pending|resolved", "--json"],
        ),
        run: async (ctx) => conflicts.runList(ctx),
      },
      resolve: {
        key: "resolve",
        help: subHelp(
          "conflicts resolve <id>",
          "Resolve a conflict.",
          [
            "--keep local|remote|both",
          ],
        ),
        run: async (ctx) => conflicts.runResolve(ctx),
      },
    },
  },
  snapshots: {
    help: groupHelp(
      "snapshots",
      "Browse restic snapshots (read-only here; use `restore` to enqueue).",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp(
          "snapshots list",
          "List snapshots.",
          ["--folder <id>", "--host <id>", "--json"],
        ),
        run: async (ctx) => snapshots.runList(ctx),
      },
    },
  },
  restore: {
    command: {
      help: {
        summary: "Enqueue a restic restore job (DESTRUCTIVE — safety rule 5).",
        usage:
          `Usage: lamasync restore <snapshotId> --to <hostId> --path <targetPath> [--yes] [--include p1,p2]\n` +
          `       lamasync restore --snapshot <id> --to <hostId> --path <targetPath>\n\n` +
          `  Flags:\n` +
          `    --snapshot <id>   restic snapshot id (positional <snapshotId> also accepted)\n` +
          `    --to <hostId>      target host (required)\n` +
          `    --path <path>      destination path on the target host (required)\n` +
          `    --folder <id>      folder id (defaults to the snapshot's folder)\n` +
          `    --include <list>   comma-separated path filter\n` +
          `    --yes, -y          skip the confirmation prompt (required non-interactively)`,
      },
      run: async (ctx) => snapshots.runRestore(ctx),
    },
  },
  browse: {
    help: groupHelp(
      "browse",
      "Read-only browse of local/S3/restic, plus browse write jobs.",
    ),
    subcommands: {
      local: {
        key: "local",
        help: subHelp("browse local", "Browse the server's backup dir.", [
          "--path <rel>",
          "--json",
        ]),
        run: async (ctx) => browse.runLocal(ctx),
      },
      s3: {
        key: "s3",
        help: subHelp("browse s3", "Browse an S3 folder's prefix.", [
          "--folder <id>",
          "--path <prefix>",
          "--json",
        ]),
        run: async (ctx) => browse.runS3(ctx),
      },
      restic: {
        key: "restic",
        help: subHelp("browse restic", "Read restic snapshots.", ["--json"]),
        run: async (ctx) => browse.runRestic(ctx),
      },
      jobs: {
        key: "jobs",
        help: subHelp("browse jobs", "List recent browse write jobs.", ["--json"]),
        run: async (ctx) => browse.runJobs(ctx),
      },
    },
  },
  notifications: {
    help: groupHelp(
      "notifications",
      "Browse durable notification events + delivery channels.",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp(
          "notifications list",
          "List notification events.",
          ["--json"],
        ),
        run: async (ctx) => notifications.runList(ctx),
      },
      channels: {
        key: "channels",
        help: subHelp(
          "notifications channels",
          "List configured delivery channels.",
          ["--json"],
        ),
        run: async (ctx) => notifications.runChannels(ctx),
      },
      test: {
        key: "test",
        help: subHelp(
          "notifications test",
          "Send a test notification (--channel delivers through one channel only).",
          ["--channel <id>", "--json"],
        ),
        run: async (ctx) => notifications.runTest(ctx),
      },
    },
  },
  hosts: {
    help: groupHelp(
      "hosts",
      "List / rename / register devices in the fleet.",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp("hosts list", "List registered devices.", ["--json"]),
        run: async (ctx) => hosts.runList(ctx),
      },
      rename: {
        key: "rename",
        help: subHelp(
          "hosts rename <hostId>",
          "Rename a host (DESTRUCTIVE — safety rule 5; id stays stable).",
          ["--hostname <new>", "--yes, -y"],
        ),
        run: async (ctx) => hosts.runRename(ctx),
      },
    },
  },
  register: {
    command: {
      help: {
        summary: "Register or update a device in the fleet.",
        usage:
          `Usage: lamasync register --hostname <name> [--tailnet-ip <ip>]\n\n` +
          `  This is the agent fallback for the install script's web UI flow.\n` +
          `  Idempotent: POSTs to /api/v1/register with the chosen name; existing\n` +
          `  rows are updated in place.`,
      },
      run: async (ctx) => hosts.runRegister(ctx),
    },
  },
  shares: {
    help: groupHelp(
      "shares",
      "List NFS / SMB shares.",
    ),
    subcommands: {
      list: {
        key: "list",
        help: subHelp("shares list", "List configured shares.", ["--json"]),
        run: async (ctx) => admin.runSharesList(ctx),
      },
    },
  },
  admin: {
    help: groupHelp(
      "admin",
      "Destructive admin operations (DESTRUCTIVE — safety rule 5).",
    ),
    subcommands: {
      prune: {
        key: "prune",
        help: subHelp(
          "admin prune",
          "Manually prune operation_log by age.",
          [
            "--older-than <ms|d|h>   age threshold (e.g. 86400000, 1d, 7d, 30d)",
            "--yes, -y               skip confirmation",
          ],
        ),
        run: async (ctx) => admin.runAdminPrune(ctx),
      },
    },
  },
  local: {
    // Help text for the local subcommand group is built inline below so
    // it can join the rest of the dispatcher without extra indirection.
    help: groupHelp(
      "local",
      "Talk to the local lamasyncd over the Unix socket.",
    ),
    subcommands: {
      status: {
        key: "status",
        help: subHelp("local status", "Show local daemon status.", ["--json"]),
        run: async (ctx) => local.runStatus(ctx),
      },
      folders: {
        key: "folders",
        help: subHelp(
          "local folders",
          "List folder assignments on this host.",
          ["--json"],
        ),
        run: async (ctx) => local.runFolders(ctx),
      },
      ops: {
        key: "ops",
        help: subHelp(
          "local ops",
          "List recent operations on this host.",
          ["--json"],
        ),
        run: async (ctx) => local.runOps(ctx),
      },
      sync: {
        key: "sync",
        help: subHelp(
          "local sync [folderId]",
          "Trigger sync for one folder (or omit to require a folder).",
          ["--json"],
        ),
        run: async (ctx) => local.runSync(ctx),
      },
      "sync-all": {
        key: "sync-all",
        help: subHelp("local sync-all", "Trigger sync for every folder.", ["--json"]),
        run: async (ctx) => local.runSyncAll(ctx),
      },
      mount: {
        key: "mount",
        help: subHelp(
          "local mount <folderId>",
          "Switch folder to mount mode.",
          ["--json"],
        ),
        run: async (ctx) => local.runMount(ctx),
      },
      unmount: {
        key: "unmount",
        help: subHelp(
          "local unmount <folderId>",
          "Switch folder back to sync mode.",
          ["--json"],
        ),
        run: async (ctx) => local.runUnmount(ctx),
      },
    },
  },
};

function groupHelp(name: string, summary: string) {
  return {
    summary,
    usage: `Use \`lamasync ${name} <subcommand> --help\` for subcommand help.`,
  };
}

function subHelp(
  inv: string,
  summary: string,
  lines: string[],
): { summary: string; usage: string } {
  const block = lines.map((l) => `  ${l}`).join("\n");
  return {
    summary,
    usage: `Usage: ${inv} [flags]\n\n${block}`,
  };
}

function statusHelp(): { summary: string; usage: string } {
  return {
    summary: "Fleet health + per-device status.",
    usage:
      `Usage: lamasync status [--json]\n\n` +
      `  Calls GET /api/v1/health and prints fleet status. Default output is a\n` +
      `  table; --json emits the raw HealthResponse from the API.\n\n` +
      `  Use \`lamasync doctor --json\` for a more detailed health report.`,
  };
}

function syncHelp(): { summary: string; usage: string } {
  return {
    summary: "Trigger a sync on a device (one folder or all).",
    usage:
      `Usage: lamasync sync [folderId] --host <hostId> [--json]\n` +
      `       lamasync sync --all --host <hostId>     # sync every assignment\n\n` +
      `  Flags:\n` +
      `    --host <hostId>    host id (required)\n` +
      `    --all              sync every assignment on the host (default when no folderId)\n` +
      `    --dry-run          request a dry-run ack from the daemon\n\n` +
      `  Triggered by enqueuing a \`trigger_sync\` queued action; the daemon\n` +
      `  picks it up on its next 5-second poll. The opposite of sync is\n` +
      `  \`lamasync backup\`, not yet implemented in v1.`,
  };
}

function doctorHelp(): { summary: string; usage: string } {
  return {
    summary: "Structured health report (env, server, socket, version).",
    usage:
      `Usage: lamasync doctor [--json]\n\n` +
      `  Reports (in order):\n` +
      `    1. env vars LAMASYNC_SERVER_URL / LAMASYNC_API_KEY presence\n` +
      `    2. API key source (flag > env > client.toml > default)\n` +
      `    3. server reachability (GET /api/v1/health) and round-trip latency\n` +
      `    4. daemon Unix socket probe (defaultSocketPath)\n` +
      `    5. binary vs latest release version drift (GitHub Releases)\n\n` +
      `  Exit non-zero when any check fails. The API key is always printed\n` +
      `  masked (\`${maskSecret("lamasync_xx")}\`).`,
  };
}

/** Top-level entry: parse argv, find the command, run it (or print help).
 *  All CliUsageError throws are caught here and result in exit 2 — the
 *  caller never needs to handle them. Runtime errors are mapped to the
 *  right exit code by `exitCodeForError()`.
 */
export async function runCli(argv: string[]): Promise<void> {
  try {
    return await runCliInner(argv);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`lamasync: ${err.message}\n`);
      process.exit(2);
    }
    if (err && typeof err === "object" && "message" in err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = exitCodeForError(err);
      // LAMA-247 #14: a `--json` invocation failing with exit 3 (auth)
      // gets a grep-able structured reason on stdout instead of only a
      // (masked) key string — `echo $? ` plus `jq .reason` works headless.
      if (code === 3 && parseArgs(argv).flags.json === true) {
        process.stdout.write(
          JSON.stringify(
            { ok: false, reason: "auth-failure", error: message, exitCode: code },
            null,
            2,
          ) + "\n",
        );
      }
      process.stderr.write(`lamasync: ${message}\n`);
      process.exit(code);
    }
    throw err;
  }
}

async function runCliInner(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  // parseArgs caps `command` at depth 2 and spills deeper words into
  // `rest`, but the dispatch tree has depth-3 paths (`dotfiles manifests
  // create`). Re-join the positional words and let walkTree consume as
  // many as the tree allows; the remainder is the command's `rest`.
  const words = [...parsed.command, ...parsed.rest];

  // Bare invocation (no positional): show top-level help. A bare --help
  // or -h at the very top level ALSO routes here (no positional given).
  if (words.length === 0) {
    process.stdout.write(`${TOP_HELP.summary}\n\n${TOP_HELP.usage}\n`);
    return;
  }

  const walkResult = walkTree(words);
  if (!walkResult) {
    throw new CliUsageError(
      `unknown command: lamasync ${words.join(" ")}`,
      words,
    );
  }

  if (wantHelp(parsed.flags)) {
    const cmd = walkResult.command;
    if (cmd) {
      process.stdout.write(`${cmd.help.summary}\n\n${cmd.help.usage}\n`);
    } else if (walkResult.help) {
      process.stdout.write(
        `${walkResult.help.summary}\n\n${walkResult.help.usage}\n`,
      );
    } else {
      process.stdout.write(`${TOP_HELP.summary}\n\n${TOP_HELP.usage}\n`);
    }
    return;
  }

  if (!walkResult.command) {
    throw new CliUsageError(
      `missing subcommand for: lamasync ${words.slice(0, walkResult.consumed).join(" ")}`,
      words.slice(0, walkResult.consumed),
    );
  }

  // Wire auth discovery. Flag precedence is handled in buildCliClient().
  const client = buildCliClient({
    flagServer: flagString(parsed.flags, "server"),
    flagKey: flagString(parsed.flags, "api-key"),
  });

  // Owner decision (2026-08-23, LAMA-247 #13): keep the friendly
  // localhost/dev-key default for the local dev loop, but make it LOUD — a
  // command running against the fake fleet must never look like a real one.
  if (client.source === "default") {
    process.stderr.write(
      "lamasync: [!] no credentials found — using fake http://localhost:8080 / dev-key. " +
        "Point at your real fleet with --server/--api-key, " +
        "LAMASYNC_SERVER_URL/LAMASYNC_API_KEY, or ~/.config/lamasync/client.toml. " +
        "(Ignore this if you really are running the local dev server.)\n",
    );
  }

  const ctx: CliContext = {
    parsed: {
      ...parsed,
      command: words.slice(0, walkResult.consumed),
      rest: words.slice(walkResult.consumed),
    },
    flags: parsed.flags,
    client,
    json: wantJson(parsed.flags),
  };

  await walkResult.command.run(ctx);
}

function wantHelp(flags: ParsedArgs["flags"]): boolean {
  return flagBool(flags, "help") || flagBool(flags, "h");
}

interface WalkResult {
  command?: CliCommandModule;
  help?: { summary: string; usage: string };
  /** How many leading words the tree consumed as the command path; the
   *  remaining words are the command's positional `rest`. */
  consumed: number;
}

function walkTree(words: string[]): WalkResult | null {
  let node: DispatchEntry | undefined = DISPATCH_TREE[words[0] ?? ""];
  if (!node) return null;
  // Group nodes (have subcommands but no command) act as namespaces. Walk
  // greedily: stop at the first word that isn't a registered subcommand —
  // that word (and the rest) belongs to the command's positional args
  // (e.g. `folders delete <id>`, `dotfiles manifests delete <id>`).
  let consumed = 1;
  while (consumed < words.length && node.subcommands) {
    const next: DispatchEntry | undefined = node.subcommands[words[consumed] ?? ""];
    if (!next) break;
    node = next;
    consumed++;
  }
  // A leaf is any node that has a `help` + `run()` pair, regardless of
  // whether it sits inside a group's `subcommands` map or whether it lives
  // at the top level as a `command`. The `command` key on a leaf is a
  // compatibility alias for top-level nodes that don't have subcommands.
  const cmd = node.command ?? (node.help && node.run
    ? ({ help: node.help, run: node.run } as CliCommandModule)
    : undefined);
  if (cmd) return { command: cmd, help: node.help, consumed };
  if (node.help) return { help: node.help, consumed };
  return null;
}

/** Every full invocation path the dispatch tree accepts — leaves and
 *  intermediate groups alike (e.g. "folders", "folders list",
 *  "dotfiles manifests", "dotfiles manifests create"). The drift check
 *  (`scripts/check-skill-drift.ts`) imports this so it doesn't have to
 *  scrape the binary's top-level `Commands:` section, which never lists
 *  children of nested groups (e.g. `dotfiles manifests list|create|delete`
 *  is invisible to the top-level help). */
export function listInvocations(): string[] {
  const out: string[] = [];
  const walk = (
    node: Record<string, DispatchEntry>,
    prefix: string[],
  ): void => {
    for (const [key, entry] of Object.entries(node)) {
      const path = [...prefix, key];
      out.push(path.join(" "));
      if (entry.subcommands) walk(entry.subcommands, path);
    }
  };
  walk(DISPATCH_TREE, []);
  return out;
}
