// Unit tests for the config-revision bump helpers (LAMA-198).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";
import {
  bumpConfigRevision,
  bumpConfigRevisionForFolder,
  bumpConfigRevisionForManifest,
  bumpConfigRevisionForPeers,
  __setDb,
} from "./config-revision.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // idempotent for pre-existing schemas
    }
  }
  db.run(
    `INSERT INTO hosts (id, hostname) VALUES ('a','a'), ('b','b'), ('c','c')`,
  );
  db.run(`INSERT INTO folders (id, name, type) VALUES ('f1','f1','sync')`);
  db.run(
    `INSERT INTO folder_assignments
       (id, folder_id, host_id, role, local_path, enabled)
     VALUES ('as-a','f1','a','both','/tmp/a',1),
            ('as-b','f1','b','both','/tmp/b',1)`,
  );
  __setDb(db);
});

afterEach(() => {
  db.close();
});

function getRev(hostId: string): number {
  const row = db
    .query<{ config_revision: number | null }, [string]>(
      "SELECT config_revision FROM hosts WHERE id = ?",
    )
    .get(hostId);
  return row?.config_revision ?? 0;
}

describe("bumpConfigRevision (LAMA-198)", () => {
  test("null hostIds bumps every host", () => {
    bumpConfigRevision();
    expect(getRev("a")).toBe(1);
    expect(getRev("b")).toBe(1);
    expect(getRev("c")).toBe(1);
  });

  test("empty array bumps every host (treats as 'all')", () => {
    bumpConfigRevision([]);
    expect(getRev("a")).toBe(1);
    expect(getRev("b")).toBe(1);
  });

  test("specific hostIds bump only those hosts", () => {
    bumpConfigRevision(["a", "c"]);
    expect(getRev("a")).toBe(1);
    expect(getRev("b")).toBe(0);
    expect(getRev("c")).toBe(1);
  });

  test("repeated bumps accumulate", () => {
    bumpConfigRevision(["a"]);
    bumpConfigRevision(["a"]);
    bumpConfigRevision(["a"]);
    expect(getRev("a")).toBe(3);
  });
});

describe("bumpConfigRevisionForFolder", () => {
  test("bumps only hosts that have an assignment for the folder", () => {
    bumpConfigRevisionForFolder("f1");
    expect(getRev("a")).toBe(1);
    expect(getRev("b")).toBe(1);
    expect(getRev("c")).toBe(0);
  });
});

describe("bumpConfigRevisionForManifest", () => {
  test("bumps only the named host", () => {
    bumpConfigRevisionForManifest("b");
    expect(getRev("a")).toBe(0);
    expect(getRev("b")).toBe(1);
    expect(getRev("c")).toBe(0);
  });
});

describe("bumpConfigRevisionForPeers", () => {
  test("bumps every other host, excluding the registering host", () => {
    bumpConfigRevisionForPeers("a");
    expect(getRev("a")).toBe(0);
    expect(getRev("b")).toBe(1);
    expect(getRev("c")).toBe(1);
  });
});