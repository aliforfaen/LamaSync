// Public surface of @lamasync/core.
export * from "./types.ts";
export { SERVER_SCHEMA, MIGRATIONS, LEGACY_S3_DROP_MIGRATIONS } from "./db/schema.ts";
export { initDb } from "./db/client.ts";
export type { Database, InitDbOptions } from "./db/client.ts";
export {
  parseServerConfig,
  parseClientConfig,
  type ServerConfig,
  type ClientConfig,
} from "./config.ts";
export {
  LamaSyncApiClient,
  LamaSyncApiError,
  type LamaSyncApiClientOptions,
} from "./api-client.ts";
export { VERSION } from "./version.ts";
export { isNewer } from "./version-compare.ts";
// LAMA-301: shared deploy output scrubbing (same module the deploy agent
// uses — one set of rules for the wire and the audit trail).
export {
  DEPLOY_OUTPUT_TAIL_CAP,
  scrubDeployOutput,
  capDeployOutputTail,
} from "./scrub.ts";
// LAMA-299: remote daemon update capability contract.
export {
  REMOTE_DAEMON_UPDATE_MIN_VERSION,
  daemonSupportsRemoteUpdate,
} from "./remote-update.ts";
export { defaultSocketPath, defaultSocketDir } from "./socket-path.ts";
// LAMA-239: per-host mount/sync override helper + AssignmentMode narrow.
export { effectiveFolderType, normalizeAssignmentMode } from "./effective-type.ts";
// LAMA-302: event-triggered sync watch configuration contract (defaults,
// quiet-period validation).
export {
  WATCH_QUIET_SEC_DEFAULT,
  WATCH_QUIET_SEC_MIN,
  WATCH_QUIET_SEC_MAX,
  resolveWatchQuietSec,
  isValidWatchQuietSec,
  normalizeWatchQuietSec,
} from "./folder-watch.ts";
// LAMA-302: operation trigger origin.
export type { TriggerOrigin } from "./types.ts";
// LAMA-294: canonical destination resolution + lock-key derivation.
export {
  canonicalDestinationKey,
  resolveDestination,
  defaultDestination,
  normalizeDestination,
} from "./destination.ts";
