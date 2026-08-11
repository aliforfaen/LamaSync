/**
 * Public entry of the CLI subpackage. `packages/tui/src/index.ts` calls
 * `runCli(process.argv.slice(2))` before booting the TUI.
 */

export { runCli } from "./dispatch.ts";
