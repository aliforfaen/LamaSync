/**
 * Helpers for safety rule 5 (mutations need intent) and rule 4
 * (consistent masking). Lives outside any single command so future
 * destructive surfaces can share the same UX.
 *
 * Convention: every destructive CLI command calls `confirmDestructive`
 * before issuing its first write. The function returns silently when the
 * operator has consented; on a decline it exits 0 with a notice. In a
 * non-interactive context (`!process.stdin.isTTY`) the operator MUST pass
 * `--yes` / `-y`, otherwise we throw CliUsageError (exit 2).
 */

import { createInterface } from "readline";

import { CliUsageError, flagBool } from "./args.ts";
import type { CliContext } from "./dispatch.ts";
import { maskSecret } from "./output.ts";

export interface ConfirmOptions {
  /** Short human-readable description (e.g. "delete folder <id>"). */
  promptMessage: string;
  /** Optional deeper explanation shown only on a TTY prompt. */
  detailsUrl?: string;
  /** Expected --yes / -y flag name (defaults to "yes"). */
  flagNameYes?: string;
}

/** Decide whether the call should proceed. When the destructive flag is
 *  missing and stdin is not a TTY, this throws CliUsageError (exit 2).
 *  When the flag is set, the function returns immediately. When stdin is
 *  a TTY, prints the prompt and waits for `y` / `yes`. A `n` /
 *  empty / anything-else answer exits 0 with a notice. */
export async function confirmDestructive(
  ctx: CliContext,
  opts: ConfirmOptions,
): Promise<void> {
  const flagName = opts.flagNameYes ?? "yes";
  if (flagBool(ctx.flags, flagName) || flagBool(ctx.flags, "y")) {
    return;
  }
  if (!process.stdin.isTTY) {
    throw new CliUsageError(
      `destructive action '${opts.promptMessage}' requires --${flagName} in non-interactive contexts (safety rule 5)`,
    );
  }
  process.stdout.write(`\nlamasync: confirm destructive action\n`);
  process.stdout.write(`  ${opts.promptMessage}\n`);
  if (opts.detailsUrl) {
    process.stdout.write(`  (see: ${opts.detailsUrl})\n`);
  }
  process.stdout.write(`  proceed? [y/N] `);
  const answer = await readLineOnce();
  process.stdout.write("\n");
  if (!answer || !["y", "yes"].includes(answer.toLowerCase())) {
    process.stdout.write("cancelled.\n");
    process.exit(0);
  }
}

function readLineOnce(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once("line", (line) => {
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      resolve("");
    });
  });
}

/** Mask an API key in a displayed object — useful for command outputs
 *  that include the key unmasked from server responses. */
export function maskKeyForDisplay(value: string | null | undefined): string {
  return maskSecret(value);
}
