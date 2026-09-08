import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "./schema.ts";
// The new mobile DTOs are exported from the core barrel (index.ts), which
// later waves consume. Importing them here from "../index.ts" proves the
// public surface re-exports them.
import type {
  MobileEnrollmentCreateResponse,
  MobileEnrollmentExchangeResponse,
  MobileMeResponse,
  MobileWebSessionBootstrapResponse,
} from "../index.ts";

// Mirrors initDb's tolerance: each migration is tried and "duplicate column"
// / already-exists errors are swallowed, so a DB that already matches the
// new schema can safely re-run the full list.
function applyMigrations(db: Database): void {
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // intentional — idempotent migrations for pre-existing schema.
    }
  }
}

const MOBILE_TABLES = [
  "mobile_enrollments",
  "mobile_registrations",
  "web_grants",
  "web_sessions",
];

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )
    .all()
    .map((r) => r.name);
}

function columnsOf(db: Database, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

// Insert a host row so registrations can satisfy the hosts FK reference.
function insertHost(db: Database, hostId: string, hostname: string): void {
  db.query("INSERT INTO hosts (id, hostname) VALUES (?, ?)").run(hostId, hostname);
}

const NOW = 1_750_000_000_000; // fixed epoch-ms anchor for deterministic tests

describe("LAMA-296 mobile schema", () => {
  test("core barrel re-exports the mobile wire DTO types", () => {
    // `satisfies` fails compilation if the barrel ever stops exporting these
    // (or if a later wave edits a field away). Sample secrets are opaque
    // placeholders only to pin the field names the routes exchange.
    const create = {
      enrollmentId: "enroll-x",
      secret: "opaque-once",
      serverOrigin: "https://fleet.example.com",
      clientType: "android",
      webAdmin: true,
      expiresAt: 1_750_000_000_000,
      expiresInSeconds: 600,
    } satisfies MobileEnrollmentCreateResponse;

    const exchange = {
      hostId: "host-x",
      nativeToken: "native-opaque",
      webGrant: "grant-opaque",
      serverOrigin: "https://fleet.example.com",
      displayName: "Pixel 9",
      clientType: "android",
    } satisfies MobileEnrollmentExchangeResponse;

    const bootstrap = {
      hostId: "host-x",
      displayName: "Pixel 9",
      expiresAt: 1_750_000_000_000,
      csrfToken: "csrf-opaque",
    } satisfies MobileWebSessionBootstrapResponse;

    const me = {
      hostId: "host-x",
      displayName: "Pixel 9",
      clientType: "android",
      appVersion: "1.2.0",
      pairedAt: 1_750_000_000_000,
      serverOrigin: "https://fleet.example.com",
    } satisfies MobileMeResponse;

    expect(create.enrollmentId).toBe("enroll-x");
    expect(exchange.hostId).toBe("host-x");
    expect(bootstrap.csrfToken).toBe("csrf-opaque");
    expect(me.clientType).toBe("android");
  });

  test("fresh DB + full migration round-trip creates the four tables and indexes", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
    // Round-trip: re-running the whole migration list over a DB that already
    // matches the schema must be a no-op (initDb does this on every open).
    applyMigrations(db);

    const names = tableNames(db);
    for (const t of MOBILE_TABLES) {
      expect(names).toContain(t);
    }
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index'",
      )
      .all()
      .map((r) => r.name);
    for (const ix of [
      "idx_mobile_enrollments_status_expires",
      "idx_web_grants_registration",
      "idx_web_sessions_registration",
      "idx_web_sessions_grant",
    ]) {
      expect(indexes).toContain(ix);
    }
  });

  test("existing DB missing the mobile tables gains them from MIGRATIONS", () => {
    // Simulate a pre-LAMA-296 DB: full fresh schema, then drop the new tables
    // as if they never existed; the migration list must recreate them.
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
    for (const t of MOBILE_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    expect(tableNames(db)).not.toContain("mobile_enrollments");

    applyMigrations(db);
    for (const t of MOBILE_TABLES) {
      expect(tableNames(db)).toContain(t);
    }
  });

  test("every secret-bearing column stores a hash; no plaintext secret column exists", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);

    const expectedHashColumns: Record<string, string[]> = {
      mobile_enrollments: ["secret_hash"],
      mobile_registrations: ["native_token_hash"],
      web_grants: ["grant_hash"],
      web_sessions: ["session_hash"],
    };
    for (const [table, hashes] of Object.entries(expectedHashColumns)) {
      const cols = columnsOf(db, table);
      for (const h of hashes) expect(cols).toContain(h);
      for (const col of cols) {
        // A column that would hold a secret value (matched on a secret word,
        // and NOT a public `_id` FK reference) must be a *_hash store. A
        // plaintext `secret`, `native_token`, `grant` or `session_secret`
        // column would fail here.
        if (/(secret|token|grant|session)/.test(col) && !/_id$/.test(col)) {
          expect(col).toMatch(/_hash$/);
        }
      }
    }
  });

  test("single-use gate lets concurrent-style exchanges yield at most one registration", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
    insertHost(db, "host-1", "pixel-9");

    const enrollmentId = "enroll-abc";
    db.query(
      `INSERT INTO mobile_enrollments
         (id, secret_hash, host_id, status, expires_at, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    ).run(enrollmentId, "h-" + "a".repeat(64), "host-1", NOW + 600_000, NOW);

    // Two "requests" race: each runs the guarded UPDATE; only the first may
    // change a row, so only one proceeds to insert the registration.
    const gate = db.query(
      `UPDATE mobile_enrollments
         SET status = 'used', consumed_at = ?
       WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    );
    const first = gate.run(NOW, enrollmentId, NOW);
    expect(first.changes).toBe(1);

    db.query(
      `INSERT INTO mobile_registrations
         (host_id, client_type, display_name, app_version, native_token_hash, created_at)
       VALUES (?, 'android', ?, ?, ?, ?)`,
    ).run("host-1", "Pixel 9", "1.0.0", "h-" + "b".repeat(64), NOW);

    // Second (replayed) exchange must not fire: the row is already used.
    const second = gate.run(NOW + 1, enrollmentId, NOW);
    expect(second.changes).toBe(0);

    // Even if it bypassed the gate, the host_id PK forbids a second
    // registration for the same host (one installation).
    expect(() =>
      db
        .query(
          `INSERT INTO mobile_registrations
             (host_id, client_type, display_name, app_version, native_token_hash, created_at)
           VALUES (?, 'android', ?, ?, ?, ?)`,
        )
        .run("host-1", "Another", "1.0.0", "h-" + "c".repeat(64), NOW),
    ).toThrow();
  });

  test("enrollment uniqueness blocks duplicate secrets and duplicate host ids", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);

    const insert = db.query(
      `INSERT INTO mobile_enrollments
         (id, secret_hash, host_id, status, expires_at, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`,
    );
    insert.run("enroll-1", "h-" + "1".repeat(64), "host-1", NOW + 600_000, NOW);

    // Same QR secret hash → rejected (a secret can back one enrollment).
    expect(() =>
      insert.run("enroll-2", "h-" + "1".repeat(64), "host-2", NOW + 600_000, NOW),
    ).toThrow();

    // Same reserved host id → rejected (a host can be installed once).
    expect(() =>
      insert.run("enroll-3", "h-" + "2".repeat(64), "host-1", NOW + 600_000, NOW),
    ).toThrow();
  });

  test("full registration → grant → session lifecycle persists hashes and linkage", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
    insertHost(db, "host-9", "galaxy");

    const enrollmentId = "enroll-9";
    db.query(
      `INSERT INTO mobile_enrollments
         (id, secret_hash, host_id, web_admin, status, expires_at, created_at, consumed_at)
       VALUES (?, ?, ?, 1, 'used', ?, ?, ?)`,
    ).run(enrollmentId, "h-" + "e".repeat(64), "host-9", NOW + 600_000, NOW, NOW);

    db.query(
      `INSERT INTO mobile_registrations
         (host_id, client_type, display_name, app_version, native_token_hash, created_at)
       VALUES (?, 'android', ?, ?, ?, ?)`,
    ).run("host-9", "Galaxy S", "1.2.0", "h-" + "n".repeat(64), NOW);

    db.query(
      `INSERT INTO web_grants (id, grant_hash, registration_id, admin, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    ).run("grant-9", "h-" + "g".repeat(64), "host-9", NOW);

    db.query(
      `INSERT INTO web_sessions
         (id, session_hash, registration_id, grant_id, admin, issued_at, expires_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run("session-9", "h-" + "s".repeat(64), "host-9", "grant-9", NOW, NOW + 12 * 3600_000);

    const reg = db
      .query<{ host_id: string; native_token_hash: string; app_version: string }, []>(
        "SELECT host_id, native_token_hash, app_version FROM mobile_registrations",
      )
      .get();
    expect(reg).toEqual({
      host_id: "host-9",
      native_token_hash: "h-" + "n".repeat(64),
      app_version: "1.2.0",
    });

    // Grant carries its admin snapshot and its 1:1 registration linkage.
    const grant = db
      .query<{ admin: number; registration_id: string }, []>(
        "SELECT admin, registration_id FROM web_grants WHERE id = 'grant-9'",
      )
      .get();
    expect(grant).toEqual({ admin: 1, registration_id: "host-9" });

    // Session lookup by hashed secret (the server hashes the cookie value).
    const session = db
      .query<{ session_hash: string; registration_id: string; grant_id: string }, []>(
        "SELECT session_hash, registration_id, grant_id FROM web_sessions WHERE id = 'session-9'",
      )
      .get();
    expect(session).toEqual({
      session_hash: "h-" + "s".repeat(64),
      registration_id: "host-9",
      grant_id: "grant-9",
    });
  });
});
