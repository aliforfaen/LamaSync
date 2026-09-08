/**
 * CLI entry point for the `lamasync` binary.
 *
 * Surface:
 *   --version / -V        print the bundled version and exit
 *   <subcommand> ...      non-interactive CLI (LAMA-229): see `lamasync <cmd> --help`
 *   (bare / --help / -h)  concise top-level help on stdout, exit 0
 *
 * There is no interactive mode: management lives in the web UI, agents use
 * the CLI plus the documented REST API (see `packages/agent-skill/`).
 *
 * Transition (LAMA-323): the legacy `lamasync-tui` binary name is published
 * for one release as a byte-identical copy of `lamasync`. When invoked under
 * the old name it prints a deprecation notice on stderr only — stdout (and
 * therefore `--json` output) stays clean.
 */
import { VERSION } from "@lamasync/core";

/** Basename of the invoked binary, or "" when unknown (e.g. `bun run src/index.ts`).
 *  Compiled Bun binaries report "bun" as argv[0]; execPath carries the real
 *  invoked path (including for copies of the compiled binary). */
function invokedBinaryName(): string {
  const execPath = process.execPath || process.argv[0] || "";
  if (!execPath) return "";
  const parts = execPath.split("/");
  return parts[parts.length - 1] ?? "";
}

/** Legacy `lamasync-tui` name kept for one transition release (LAMA-323). */
const LEGACY_BINARY_NAME = "lamasync-tui";

export async function main(): Promise<void> {
  const invoked = invokedBinaryName();
  if (invoked === LEGACY_BINARY_NAME) {
    process.stderr.write(
      "lamasync-tui is deprecated and will be removed in an upcoming release; use `lamasync` instead.\n",
    );
  }

  if (
    process.argv.includes("--version") ||
    process.argv.includes("-V")
  ) {
    // Preserve the historical `<binary-name> <VERSION>` shape so scripts
    // parsing `--version` keep working through the rename.
    console.log(`${invoked === LEGACY_BINARY_NAME ? invoked : "lamasync"} ${VERSION}`);
    process.exit(0);
  }

  const { runCli } = await import("./cli/index.ts");
  await runCli(process.argv.slice(2));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`lamasync: fatal: ${message}\n`);
  process.exit(1);
});
