/**
 * TUI entry point. Resolves a few CLI flags and hands off to `bootShell`,
 * which wires every registered view through the foundation `Shell`.
 *
 * CLI surface:
 *   --version / -V        print the bundled version and exit
 *   <subcommand> ...      non-interactive CLI (LAMA-229): see `lamasync <cmd> --help`
 *   --help / -h           show top-level CLI help (also `<cmd> --help`)
 *
 * Renderer-init failures matching `/renderer|native/` fall back to the CLI
 * fallback so the binary remains useful in headless environments.
 *
 * `LAMASYNC_NO_TUI=1` with no subcommand still routes to `runCliFallback()`
 * (the legacy behavior); subcommands always win over it.
 */
import { VERSION } from "@lamasync/core";

import { parseArgs } from "./cli/args.ts";
import { runCli } from "./cli/index.ts";
import { bootShell } from "./boot.ts";
import { runCliFallback } from "./cli-fallback.ts";

export { bootShell } from "./boot.ts";

/** Decide whether `argv` (already stripped of binary name) is a CLI
 *  invocation or just a TUI boot with flag overrides. The parser knows
 *  about flag-value pairs so a URL passed as `--server http://x`'s value
 *  doesn't get misclassified as a positional command. */
function looksLikeCli(argv: string[]): boolean {
  const parsed = parseArgs(argv);
  if (parsed.hasCommand) return true;
  if (argv.includes("--help") || argv.includes("-h")) return true;
  return false;
}

export async function main(): Promise<void> {
  if (
    process.argv.includes("--version") ||
    process.argv.includes("-V")
  ) {
    console.log(`lamasync-tui ${VERSION}`);
    process.exit(0);
  }

  const argv = process.argv.slice(2);

  // CLI dispatch is invoked when the parser observes a positional that
  // wasn't consumed as a flag value (see `looksLikeCli` + `parseArgs`).
  // Bare flag overrides (`lamasync --server http://x --api-key y`) leave
  // the TUI boot or `runCliFallback` path alone.
  if (looksLikeCli(argv)) {
    await runCli(argv);
    return;
  }

  if (process.env.LAMASYNC_NO_TUI === "1") {
    await runCliFallback();
    return;
  }

  try {
    await bootShell();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("renderer") || message.includes("native")) {
      console.error(
        `OpenTUI failed (${message}); falling back to CLI mode.`,
      );
      await runCliFallback();
      return;
    }
    throw err;
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`TUI fatal: ${message}`);
  process.exit(1);
});
