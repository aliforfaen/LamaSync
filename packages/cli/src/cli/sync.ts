/**
 * `lamasync sync` — trigger a sync action on the daemon.
 *
 *   lamasync sync                       # every assignment on --host (default)
 *   lamasync sync <folderId> --host X   # one folder
 *   lamasync sync --all --host X        # every assignment on that host (explicit)
 *   lamasync sync <folderId> --host X --dry-run   # request a dry-run ack
 *
 * The daemon picks the action up on its 5-second poll. We do NOT wait for
 * the result here — that's a different (async) workflow, better suited for
 * a future `lamasync wait` subcommand. The exit code only signals whether
 * the server accepted the action; failures within the daemon show up via
 * `lamasync ops list --host X` once the daemon reports them.
 */

import { CliUsageError, flagBool, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { printJson } from "./output.ts";

export async function run(ctx: CliContext): Promise<void> {
  const { client, json, flags, parsed } = ctx;
  const hostId = flagString(flags, "host");
  if (!hostId) {
    throw new CliUsageError("sync requires --host <hostId>");
  }
  const folderId = parsed.rest[0];
  // Handoff contract: without a folderId, sync all assignments on the host.
  // `--all` stays accepted for explicitness; both paths send `all: true`.
  const all = flagBool(flags, "all") || !folderId;
  const dryRun = flagBool(flags, "dry-run");

  // LAMA-198: payload lets a specific folder be targeted by the daemon's
  // `selectAssignmentsForSyncAction` filter. `all: true` is the daemon-side
  // explicit signal to sync every assignment regardless of folderId.
  const payload: Record<string, unknown> = {};
  if (folderId) payload.folderId = folderId;
  if (all) payload.all = true;
  if (dryRun) payload.dryRun = true;

  let action;
  try {
    action = await client.client.enqueueAction(hostId, {
      type: "trigger_sync",
      payload: Object.keys(payload).length > 0 ? payload : null,
    });
  } catch (err) {
    throw wrapApiError(err, "sync");
  }

  if (json) {
    printJson(action);
    return;
  }
  console.log(`enqueued trigger_sync for ${hostId}${folderId ? ` (folder ${folderId})` : " (all)"}${dryRun ? " [dry-run]" : ""}`);
  console.log(`action id: ${action.id}`);
}
