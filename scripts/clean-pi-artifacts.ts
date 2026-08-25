// LAMA-247 #20: nuke accumulated `.pi-subagents/` artifacts (indexed,
// ignored, but the dir grows with every run). `bun run clean:pi`.

import { existsSync, rmSync } from "fs";
import { join } from "path";

const target = join(import.meta.dir, "..", ".pi-subagents");
if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
} else {
  console.log("no .pi-subagents/ to clean");
}