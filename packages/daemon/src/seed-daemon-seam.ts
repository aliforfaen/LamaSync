// LAMA-346 Stage 2d — the daemon's seed seam, in its own dependency-free module.
//
// `lamasyncd`'s action dispatcher has to decide whether seed work is reachable
// BEFORE it loads the seed runner, and the runner has to check again when it
// runs. Sharing one predicate means those two checks cannot drift, and putting
// it in a module with no imports means the dispatcher can read it without
// pulling the relay transport or the S3 store into its module graph — which is
// the property `seed-transport-bounded.test.ts` asserts.
//
// The rule is deliberately narrow: BOTH variables are required. `LAMASYNC_TEST=1`
// is set by several unrelated harnesses, and `LAMASYNC_SEED_E2E=1` alone is a
// single knob; neither opens a seed path on its own, and the server's seam is
// the same shape so one environment cannot open one side without the other.

/** True only when the doubly-gated seed E2E seam is fully open. */
export function seedDaemonE2eEnabled(): boolean {
  return process.env["LAMASYNC_SEED_E2E"] === "1" && process.env["LAMASYNC_TEST"] === "1";
}
