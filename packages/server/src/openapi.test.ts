// OpenAPI metadata regression audit (LAMA-API-AUDIT).
//
// The generated /swagger/json spec is the machine contract every API client
// consumes (Swagger UI, the agent skill, tooling). This test holds it to
// the invariants that historically drifted:
//   - info.version tracks VERSION from @lamasync/core (never hard-coded)
//   - info.description describes the current surface (no legacy "dotfile
//     storage" wording)
//   - every operation tag is declared exactly once in spec.tags
//   - every used tag is declared (no used-but-undeclared tags)
//   - the global bearer security is overridden with security: [] on the
//     three deliberate pre-auth operations (pairing exchange, mobile
//     enrollment exchange, mobile web-session bootstrap)
//   - every HTTP operation declares responses
//
// It composes the real app via createServerApp() (no listener, no boot
// timers) and queries /swagger/json through app.handle, so it exercises the
// exact swagger generation path the live server uses.

import { beforeAll, expect, test } from "bun:test";
import { VERSION } from "@lamasync/core";

interface OpenApiSpec {
  info: { title: string; version: string; description: string };
  tags?: Array<{ name: string; description?: string }>;
  security?: unknown;
  paths: Record<
    string,
    Record<
      string,
      {
        summary?: string;
        tags?: string[];
        security?: unknown;
        responses?: Record<string, unknown>;
      }
    >
  >;
}

/** Every HTTP operation in the composed app's generated spec. */
function collectOperations(spec: OpenApiSpec): Array<{
  method: string;
  path: string;
  operation: OpenApiSpec["paths"][string][string];
}> {
  const out: Array<{ method: string; path: string; operation: OpenApiSpec["paths"][string][string] }> = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method === "parameters" || method === "servers") continue;
      out.push({ method, path, operation });
    }
  }
  return out;
}

let spec: OpenApiSpec;
let operations: ReturnType<typeof collectOperations>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenApiSpec(value: unknown): value is OpenApiSpec {
  if (!isRecord(value) || !isRecord(value.info) || !isRecord(value.paths)) return false;
  return (
    typeof value.info.title === "string" &&
    typeof value.info.version === "string" &&
    typeof value.info.description === "string"
  );
}

beforeAll(async () => {
  // Compose the full route graph in a child process. Importing app.ts in this
  // test process would share route modules' injectable `activeDb` state with
  // concurrently running route tests, making the suite order-dependent.
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      'const { createServerApp } = await import("./app.ts"); const response = await createServerApp().handle(new Request("http://127.0.0.1/swagger/json")); if (!response.ok) process.exit(1); process.stdout.write(await response.text());',
    ],
    cwd: import.meta.dir,
    env: {
      ...process.env,
      LAMASYNC_API_KEY: "openapi-test-master-key-1234567890",
      LAMASYNC_SECRET_KEY: "openapi-test-secret-key-1234567890",
      LAMASYNC_TEST: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode, stderr).toBe(0);
  const parsed: unknown = JSON.parse(stdout);
  expect(isOpenApiSpec(parsed)).toBe(true);
  if (!isOpenApiSpec(parsed)) throw new Error("generated OpenAPI document has an invalid shape");
  spec = parsed;
  operations = collectOperations(spec);
});

test("info.version tracks the core VERSION constant", () => {
  expect(spec.info.version).toBe(VERSION);
});

test("info.description describes the current apps/mobile/backends surface", () => {
  expect(spec.info.description).toContain("application captures");
  expect(spec.info.description).toContain("mobile device onboarding and uploads");
  expect(spec.info.description).toContain("backend management");
  // Stale legacy wording must never come back.
  expect(spec.info.description).not.toContain("dotfile");
});

test("spec named tags are declared exactly once", () => {
  const declared = (spec.tags ?? []).map((t) => t.name);
  const seen = new Set<string>();
  for (const name of declared) {
    // Duplicate declarations are the historical failure (Health appeared
    // twice); a second occurrence must fail loudly.
    expect(seen.has(name)).toBe(false);
    seen.add(name);
  }
  expect(declared.length).toBeGreaterThan(15);
});

test("every operation tag is declared", () => {
  const declared = new Set((spec.tags ?? []).map((t) => t.name));
  const used = new Set<string>();
  for (const { operation } of operations) {
    for (const tag of operation.tags ?? []) used.add(tag);
  }
  expect(used.size).toBeGreaterThan(10);
  for (const tag of used) {
    expect(declared.has(tag), `operation tag "${tag}" used but never declared`).toBe(true);
  }
});

test("the three pre-auth operations override the global bearer security", () => {
  const preAuth: Array<[string, string]> = [
    ["/api/v1/pairing/{code}/exchange", "post"],
    ["/api/v1/mobile/enrollments/{id}/exchange", "post"],
    ["/api/v1/mobile/web-session", "post"],
  ];
  for (const [path, method] of preAuth) {
    const operation = spec.paths[path]?.[method];
    expect(operation, `expected ${method.toUpperCase()} ${path} in the spec`).toBeTruthy();
    expect(operation?.security, `${method.toUpperCase()} ${path} must be marked public`).toEqual([]);
  }
});

test("protected operations inherit the global bearer security", () => {
  // The document default is the bearer scheme…
  expect(spec.security).toEqual([{ bearerAuth: [] }]);
  // …and a normal protected operation carries no operation-level override.
  for (const path of ["/api/v1/health", "/api/v1/hosts"]) {
    const operation = spec.paths[path]?.get;
    expect(operation, `expected GET ${path}`).toBeTruthy();
    expect(operation?.security, `GET ${path} should inherit the global security`).toBeUndefined();
  }
});

test("every HTTP operation declares responses", () => {
  const paths = Object.keys(spec.paths);
  expect(paths.length).toBeGreaterThanOrEqual(100);
  for (const { method, path, operation } of operations) {
    expect(operation.responses, `${method.toUpperCase()} ${path} is missing responses`).toBeTruthy();
    expect(Object.keys(operation.responses ?? {}).length, `${method.toUpperCase()} ${path} has empty responses`).toBeGreaterThan(0);
  }
});

test("the web UI root is the only untagged non-API surface", () => {
  const untagged = operations.filter(({ operation }) => !operation.tags || operation.tags.length === 0);
  expect(untagged.map(({ method, path }) => `${method.toUpperCase()} ${path}`)).toEqual(["GET /"]);
});
