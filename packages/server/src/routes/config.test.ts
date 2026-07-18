// config.ts transitively imports db.ts which does mkdirSync(LAMASYNC_DATA_DIR || "/data")
// at module-init time. Set the env before any import reaches that side-effect.
process.env.LAMASYNC_DATA_DIR = process.env.LAMASYNC_DATA_DIR ?? "/tmp/lamasync-test-data";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  DotfileManifest,
  Folder,
  FolderAssignment,
  Host,
} from "@lamasync/core";
import { initDb } from "@lamasync/core";
import { Database } from "bun:sqlite";
import { generateRcloneConfig } from "./config.ts";

// Module-scoped DB instance so `db` (imported transitively by config.ts) sees
// the right schema. config.ts queries the DB to look up peer-shared folder ids,
// so we need a working schema even for tests that pass `peers = []`.
let db: Database;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lamasync-cfg-test-"));
  db = initDb(join(dataDir, "test.db"));
  // config.ts uses a singleton `db` imported from ../db.ts; we swap it on
  // the module by replacing the export via a setter the helper exposes.
  setConfigDb(db);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "folder-1",
    name: "MyDocs",
    type: "sync",
    encrypted: false,
    cryptPassword: null,
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<FolderAssignment> = {}): FolderAssignment {
  return {
    id: "assignment-1",
    folderId: "folder-1",
    hostId: "host-1",
    role: "source",
    localPath: "/tmp/lamasync-test",
    enabled: true,
    ...overrides,
  };
}

function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "host-1",
    hostname: "test-host",
    tailnetIp: "100.100.100.1",
    lastSeen: Date.now(),
    status: "online",
    ...overrides,
  };
}

describe("generateRcloneConfig — encryption at rest (LAMA-124)", () => {
  test("emits a backend and a crypt remote for an encrypted sync folder", () => {
    const folder = makeFolder({
      id: "enc-1",
      name: "vault",
      type: "sync",
      encrypted: true,
      cryptPassword: "ZGVhZGJlZWZkZWFkYmVlZg==",
    });
    const assignment = makeAssignment({ folderId: "enc-1" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;

    // Backend section exists and uses sftp (server tailnet IP set).
    expect(cfg).toContain("[lamasync-enc-1-backend]");
    expect(cfg).toMatch(/\[lamasync-enc-1-backend\][\s\S]*type = sftp/);
    expect(cfg).toMatch(/\[lamasync-enc-1-backend\][\s\S]*host = 100\.100\.100\.1/);

    // Crypt section exists with the right name + fields.
    expect(cfg).toContain("[lamasync-enc-1]");
    const cryptMatch = /\[lamasync-enc-1\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
    expect(cryptMatch).not.toBeNull();
    const cryptBlock = cryptMatch![1];
    expect(cryptBlock).toContain("type = crypt");
    expect(cryptBlock).toContain("remote = lamasync-enc-1-backend:vault");
    expect(cryptBlock).toContain("password = ZGVhZGJlZWZkZWFkYmVlZg==");
    expect(cryptBlock).toContain("password2 = ZGVhZGJlZWZkZWFkYmVlZg==");

    // Sanity: no spurious plaintext section for the folder itself.
    expect(cfg).not.toMatch(/\[lamasync-enc-1\][\s\S]*type = sftp/);

    // No peers detected for this test.
    expect(out.peers).toEqual([]);
  });

  test("crypt password is base64-decodable", () => {
    const folder = makeFolder({
      id: "enc-2",
      name: "vault2",
      type: "backup",
      encrypted: true,
      cryptPassword: "YWJjZGVmZ2hpamtsbW5vcA==",
    });
    const assignment = makeAssignment({ folderId: "enc-2" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cryptMatch = /\[lamasync-enc-2\]([\s\S]*?)(?=\n\[|$)/.exec(out.rcloneConfig);
    expect(cryptMatch).not.toBeNull();
    const passMatch = /password = (\S+)/.exec(cryptMatch![1]);
    expect(passMatch).not.toBeNull();
    const decoded = Buffer.from(passMatch![1], "base64").toString("utf8");
    expect(decoded).toBe("abcdefghijklmnop");
  });

  test("emits the crypt section as lamasync-<folderId> even when assignment.remoteName is custom", () => {
    const folder = makeFolder({
      id: "enc-3",
      name: "vault3",
      type: "sync",
      encrypted: true,
      cryptPassword: "cGFzc3dvcmQ=",
    });
    const assignment = makeAssignment({ folderId: "enc-3", remoteName: "custom-name" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;
    // The crypt section is always `lamasync-<folderId>` (daemon's getRemoteName
    // default). The custom assignment.remoteName is not used as a section name.
    expect(cfg).toContain("[lamasync-enc-3]");
    expect(cfg).toContain("[lamasync-enc-3-backend]");
    expect(cfg).not.toContain("[custom-name]");
  });

  test("encrypted dotfile folders fall through to the plain dotfile branch", () => {
    // Dotfile remote shape is local-only and is not currently wrapped in
    // crypt — the design treats dotfile backups as out-of-scope for at-rest
    // encryption.
    const folder = makeFolder({
      id: "enc-df",
      name: "rc",
      type: "dotfile",
      encrypted: true,
      cryptPassword: "cGFzcw==",
    });
    const assignment = makeAssignment({ folderId: "enc-df" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    expect(out.rcloneConfig).toContain("[lamasync-enc-df]");
    expect(out.rcloneConfig).not.toContain("[lamasync-enc-df-backend]");
    expect(out.rcloneConfig).toMatch(
      /\[lamasync-enc-df\][\s\S]*type = local[\s\S]*dotfile backup/,
    );
  });

  test("non-encrypted folders still use the assignment.remoteName", () => {
    const folder = makeFolder({
      id: "plain-1",
      name: "photos",
      type: "sync",
      encrypted: false,
      cryptPassword: null,
    });
    const assignment = makeAssignment({ folderId: "plain-1", remoteName: "my-photos-remote" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    expect(out.rcloneConfig).toContain("[my-photos-remote]");
    expect(out.rcloneConfig).not.toContain("[lamasync-plain-1]");
  });

  test("encrypted folder with missing cryptPassword falls through to the plain branch", () => {
    // A folder flagged encrypted without a stored password is degenerate and
    // must NOT crash the config generator; it falls back to the unencrypted
    // remote shape so the daemon keeps syncing in the clear.
    const folder = makeFolder({
      id: "enc-broken",
      name: "broken",
      type: "sync",
      encrypted: true,
      cryptPassword: null,
    });
    const assignment = makeAssignment({ folderId: "enc-broken" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    expect(out.rcloneConfig).toContain("[lamasync-enc-broken]");
    expect(out.rcloneConfig).not.toContain("[lamasync-enc-broken-backend]");
    expect(out.rcloneConfig).toMatch(/\[lamasync-enc-broken\][\s\S]*type = sftp/);
  });
});

describe("generateRcloneConfig — S3 backend (LAMA-105)", () => {
  test("non-encrypted S3 folder emits backend + alias remote", () => {
    const folder = makeFolder({
      id: "s3-1",
      name: "exoscale-vault",
      type: "sync",
      backend: "s3",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "lamasync-vault",
      s3AccessKeyId: "EXO_KEY",
      s3SecretAccessKey: "EXO_SECRET",
      s3Region: "vie-1",
    });
    const assignment = makeAssignment({ folderId: "s3-1" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;
    expect(cfg).toContain("[lamasync-s3-1-backend]");
    expect(cfg).toMatch(/\[lamasync-s3-1-backend\][\s\S]*type = s3/);
    expect(cfg).toMatch(/\[lamasync-s3-1-backend\][\s\S]*provider = Other/);
    expect(cfg).toMatch(/\[lamasync-s3-1-backend\][\s\S]*endpoint = sos-at-vie-1\.exo\.io/);
    expect(cfg).toMatch(/\[lamasync-s3-1-backend\][\s\S]*access_key_id = EXO_KEY/);
    expect(cfg).toMatch(/\[lamasync-s3-1-backend\][\s\S]*secret_access_key = EXO_SECRET/);
    expect(cfg).toMatch(/\[lamasync-s3-1-backend\][\s\S]*region = vie-1/);
    // Alias section points at the bucket.
    expect(cfg).toMatch(/\[lamasync-s3-1\][\s\S]*type = alias[\s\S]*remote = lamasync-s3-1-backend:lamasync-vault/);
    // No sftp section for this folder.
    expect(cfg).not.toMatch(/\[lamasync-s3-1\][\s\S]*type = sftp/);
  });

  test("encrypted S3 folder emits S3 backend + crypt remote pointing at bucket", () => {
    const folder = makeFolder({
      id: "s3-2",
      name: "exoscale-vault-enc",
      type: "sync",
      encrypted: true,
      cryptPassword: "cGFzc3dvcmQ=",
      backend: "s3",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "lamasync-vault-enc",
      s3AccessKeyId: "EXO_KEY2",
      s3SecretAccessKey: "EXO_SECRET2",
    });
    const assignment = makeAssignment({ folderId: "s3-2" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;
    expect(cfg).toContain("[lamasync-s3-2-backend]");
    expect(cfg).toMatch(/\[lamasync-s3-2-backend\][\s\S]*type = s3/);
    expect(cfg).toMatch(/\[lamasync-s3-2\][\s\S]*type = crypt/);
    expect(cfg).toMatch(
      /\[lamasync-s3-2\][\s\S]*remote = lamasync-s3-2-backend:lamasync-vault-enc/,
    );
    expect(cfg).not.toMatch(/\[lamasync-s3-2\][\s\S]*type = sftp/);
    expect(cfg).not.toMatch(/\[lamasync-s3-2\][\s\S]*type = alias/);
  });

  test("S3 folder honours assignment.remoteName on the alias section", () => {
    const folder = makeFolder({
      id: "s3-3",
      name: "exoscale-vault-named",
      type: "sync",
      backend: "s3",
      s3Endpoint: "sos-at-vie-1.exo.io",
      s3Bucket: "named-bucket",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "SECRET",
    });
    const assignment = makeAssignment({ folderId: "s3-3", remoteName: "my-vault" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;
    expect(cfg).toContain("[my-vault]");
    expect(cfg).toMatch(/\[my-vault\][\s\S]*type = alias[\s\S]*remote = lamasync-s3-3-backend:named-bucket/);
    expect(cfg).not.toContain("[lamasync-s3-3]");
  });

  test("S3 folder without region omits the region key", () => {
    const folder = makeFolder({
      id: "s3-4",
      name: "no-region",
      type: "backup",
      backend: "s3",
      s3Endpoint: "s3.amazonaws.com",
      s3Bucket: "no-region-bucket",
      s3AccessKeyId: "KEY",
      s3SecretAccessKey: "SECRET",
    });
    const assignment = makeAssignment({ folderId: "s3-4" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;
    expect(cfg).toMatch(/\[lamasync-s3-4-backend\][\s\S]*type = s3/);
    expect(cfg).not.toMatch(/\[lamasync-s3-4-backend\][\s\S]*region =/);
  });

  test("plain SFTP folder (no backend) keeps existing sftp behavior", () => {
    const folder = makeFolder({
      id: "sftp-1",
      name: "legacy",
      type: "sync",
    });
    const assignment = makeAssignment({ folderId: "sftp-1" });
    const out = generateRcloneConfig(
      "host-1",
      [folder],
      [assignment],
      "100.100.100.1",
      "/backups",
    );
    const cfg = out.rcloneConfig;
    expect(cfg).toContain("[lamasync-sftp-1]");
    expect(cfg).toMatch(/\[lamasync-sftp-1\][\s\S]*type = sftp/);
    expect(cfg).not.toContain("[lamasync-sftp-1-backend]");
  });
});

// --- helpers --------------------------------------------------------------
function setConfigDb(next: Database): void {
  const mod = require("./config.ts") as { __setDb?: (db: Database) => void };
  if (typeof mod.__setDb === "function") mod.__setDb(next);
}