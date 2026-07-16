// Reads root package.json version and writes it to packages/core/src/version.ts.
// Run before building any package so the VERSION constant is up to date.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const versionTs = `// Generated during build — do not edit by hand.
// Source of truth: root package.json "version" field.
export const VERSION = "${pkg.version}";
`;

writeFileSync(resolve(rootDir, "packages", "core", "src", "version.ts"), versionTs);
console.log(`[gen-version] wrote version ${pkg.version}`);
