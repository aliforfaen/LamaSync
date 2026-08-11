/**
 * `lamasync backends list|create|test`.
 *
 *   - `list`   → GET /backends, table or JSON. `hasSecret` (boolean) is the
 *                only signal that credentials are stored; the secret itself
 *                never appears on the wire.
 *   - `create` → POST /backends with the kind-specific required fields.
 *                All secret values are write-only and never printed.
 *   - `test`   → POST /backends/:id/test, prints the server's verification
 *                result.
 */

import type { Backend, BackendKind, S3Provider } from "@lamasync/core";

import { CliUsageError, requireFlagString, flagString } from "./args.ts";
import { wrapApiError } from "./client.ts";
import type { CliContext } from "./dispatch.ts";
import { maskSecretsDeep, printJson, printTable } from "./output.ts";

const BACKEND_KINDS: BackendKind[] = ["s3", "local", "nfs", "restic"];
const S3_PROVIDERS: S3Provider[] = ["exoscale", "aws", "other"];

export async function runList(ctx: CliContext): Promise<void> {
  const { client, json } = ctx;
  let backends: Backend[];
  try {
    backends = await client.client.listBackends();
  } catch (err) {
    throw wrapApiError(err, "list backends");
  }
  // Server returns extra fields (`folderCount`) when present. We mask any
  // accidentally-leaked secret keys here too, just to be defensive.
  const clean = backends.map((b) => maskSecretsDeep(b));
  if (json) {
    printJson(clean);
    return;
  }
  printTable(
    [
      { header: "NAME", key: "name" },
      { header: "KIND", key: "kind" },
      { header: "S3 PROVIDER", key: "s3Provider" },
      { header: "ENDPOINT", key: "endpoint" },
      { header: "BUCKET/LOCAL", key: "path" },
      { header: "HAS SECRET", key: "hasSecret" },
      { header: "ID", key: "id" },
    ],
    clean.map((b) => ({
      name: b.name,
      kind: b.kind,
      s3Provider: b.s3Provider ?? "",
      endpoint: b.s3Endpoint ?? "",
      path: (b as Backend & { localPath?: string | null }).localPath ?? b.resticRepository ?? "",
      hasSecret: b.hasSecret ? "yes" : "no",
      id: b.id,
    })),
  );
}

export async function runCreate(ctx: CliContext): Promise<void> {
  const { client, json, flags } = ctx;
  const name = requireFlagString(flags, "name");
  const kindRaw = requireFlagString(flags, "kind");
  if (!BACKEND_KINDS.includes(kindRaw as BackendKind)) {
    throw new CliUsageError(
      `invalid --kind '${kindRaw}'; expected one of: ${BACKEND_KINDS.join(", ")}`,
    );
  }
  const kind = kindRaw as BackendKind;

  const body: Parameters<typeof client.client.createBackend>[0] = { name, kind };
  if (kind === "s3") {
    const providerRaw = flagString(flags, "s3-provider");
    const provider =
      providerRaw && S3_PROVIDERS.includes(providerRaw as S3Provider)
        ? (providerRaw as S3Provider)
        : "other";
    const endpoint = requireFlagString(flags, "s3-endpoint");
    const accessKeyId = requireFlagString(flags, "s3-access-key-id");
    const secretAccessKey = requireFlagString(flags, "s3-secret-access-key");
    const region = flagString(flags, "s3-region") ?? null;
    body.s3Provider = provider;
    body.s3Endpoint = endpoint;
    body.s3AccessKeyId = accessKeyId;
    body.s3SecretAccessKey = secretAccessKey;
    body.s3Region = region ?? undefined;
  } else if (kind === "local" || kind === "nfs") {
    body.localPath = requireFlagString(flags, "local-path");
  } else {
    body.resticRepository = requireFlagString(flags, "restic-repository");
    body.resticPassword = requireFlagString(flags, "restic-password");
  }

  let backend: Backend;
  try {
    backend = await client.client.createBackend(body);
  } catch (err) {
    throw wrapApiError(err, "create backend");
  }
  const clean = maskSecretsDeep(backend);
  if (json) {
    printJson(clean);
    return;
  }
  console.log(`created backend ${backend.id} (${backend.name})`);
  console.log(`kind: ${backend.kind}`);
  if (backend.kind === "s3") {
    console.log(`endpoint: ${backend.s3Endpoint ?? ""}`);
    console.log(`provider: ${backend.s3Provider ?? ""}`);
    console.log(`secret stored: ${backend.hasSecret ? "yes" : "no"}`);
  } else if (backend.kind === "local" || backend.kind === "nfs") {
    console.log(`path: ${(backend as Backend & { localPath?: string | null }).localPath ?? ""}`);
  } else if (backend.kind === "restic") {
    console.log(`repository: ${backend.resticRepository ?? ""}`);
    console.log(`password stored: ${backend.hasResticPassword ? "yes" : "no"}`);
  }
}

export async function runTest(ctx: CliContext): Promise<void> {
  const { client, json, parsed } = ctx;
  const id = parsed.rest[0] ?? "";
  if (!id) {
    throw new CliUsageError(
      "backends test <backendId> requires an id as the first positional",
    );
  }
  let result: { ok: boolean; detail?: string };
  try {
    result = await client.client.testBackend(id);
  } catch (err) {
    throw wrapApiError(err, "test backend");
  }
  if (json) {
    printJson(result);
    return;
  }
  if (result.ok) {
    console.log(`backend ${id}: OK${result.detail ? ` — ${result.detail}` : ""}`);
    return;
  }
  console.error(
    `backend ${id}: FAIL${result.detail ? ` — ${result.detail}` : ""}`,
  );
  process.exit(1);
}
