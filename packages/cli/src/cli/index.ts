/**
 * Public entry of the CLI subpackage. `packages/cli/src/index.ts` (the
 * `lamasync` binary entry) calls `runCli(process.argv.slice(2))`.
 */

export { runCli } from "./dispatch.ts";
