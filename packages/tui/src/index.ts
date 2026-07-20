/**
 * TUI entry point. Resolves a few CLI flags and hands off to `bootShell`,
 * which wires every registered view through the foundation `Shell`.
 *
 * CLI surface preserved from the pre-slice build:
 *   --version / -V        print the bundled version and exit
 *   LAMASYNC_NO_TUI=1     bypass the OpenTUI renderer and run the CLI fallback
 *
 * Renderer-init failures matching `/renderer|native/` fall back to the CLI
 * fallback so the binary remains useful in headless environments.
 */
import { VERSION } from "@lamasync/core";

import { bootShell } from "./boot.ts";
import { runCliFallback } from "./cli-fallback.ts";

export { bootShell } from "./boot.ts";

export async function main(): Promise<void> {
  if (
    process.argv.includes("--version") ||
    process.argv.includes("-V")
  ) {
    console.log(`lamasync-tui ${VERSION}`);
    process.exit(0);
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
