import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { MIGRATIONS, SERVER_SCHEMA } from "./schema.ts";
import { initDb } from "./client.ts";
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
      "idx_mobile_enrollments_host_id",
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

  test("enrollment uniqueness blocks duplicate secrets and duplicate ids, but a host keeps an enrollment history", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);

    const insert = db.query(
      `INSERT INTO mobile_enrollments
         (id, secret_hash, host_id, kind, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    );
    insert.run("enroll-1", "h-" + "1".repeat(64), "host-1", "new", NOW + 600_000, NOW);

    // Same QR secret hash → rejected (a secret can back one enrollment).
    expect(() =>
      insert.run("enroll-2", "h-" + "1".repeat(64), "host-2", "new", NOW + 600_000, NOW),
    ).toThrow();

    // Same id → rejected (the primary key).
    expect(() =>
      insert.run("enroll-1", "h-" + "2".repeat(64), "host-3", "new", NOW + 600_000, NOW),
    ).toThrow();

    // LAMA-337: the SAME host id is allowed now — one device keeps the
    // history of the QRs shown for it, including a reconnect QR and the
    // used pairing enrollment that created the registration.
    insert.run("enroll-3", "h-" + "3".repeat(64), "host-1", "new", NOW + 600_000, NOW);
    insert.run("enroll-4", "h-" + "4".repeat(64), "host-1", "reconnect", NOW + 600_000, NOW);
    const rows = db
      .query<{ kind: string }, [string]>(
        "SELECT kind FROM mobile_enrollments WHERE host_id = ? ORDER BY created_at, id",
      )
      .all("host-1");
    expect(rows.map((r) => r.kind)).toEqual(["new", "new", "reconnect"]);
  });

  test("seeds kind from a pre-LAMA-337 table's default for legacy rows", () => {
    const db = new Database(":memory:");
    db.exec(SERVER_SCHEMA);
    db.run(
      `INSERT INTO mobile_enrollments
         (id, secret_hash, host_id, status, expires_at, created_at)
       VALUES ('legacy-1', ?, 'host-legacy', 'used', ?, ?)`,
      ["h-" + "a".repeat(64), NOW + 600_000, NOW],
    );
    const kind = db
      .query<{ kind: string }, []>("SELECT kind FROM mobile_enrollments")
      .get();
    expect(kind?.kind).toBe("new");
  });

  // -------------------------------------------------------------------------
  // LAMA-337: the one-time rebuild of a legacy table
  // -------------------------------------------------------------------------

  /** A `mobile_enrollments` table exactly as LAMA-296 created it: UNIQUE on
   *  host_id and no `kind` column. */
  const LEGACY_ENROLLMENTS_TABLE = `
    CREATE TABLE mobile_enrollments (
      id            TEXT PRIMARY KEY,
      secret_hash   TEXT NOT NULL UNIQUE,
      host_id       TEXT NOT NULL UNIQUE,
      client_type   TEXT NOT NULL DEFAULT 'android',
      web_admin     INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending',
      expires_at    INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      consumed_at   INTEGER,
      revoked_at    INTEGER
    )`;

  function insertLegacyRow(db: Database, id: string, hostId: string): void {
    db.run(
      `INSERT INTO mobile_enrollments
         (id, secret_hash, host_id, web_admin, status, expires_at, created_at, consumed_at)
       VALUES (?, ?, ?, 1, 'used', ?, ?, ?)`,
      [id, `h-${id.repeat(64).slice(0, 64)}`, hostId, NOW + 600_000, NOW, NOW],
    );
  }

  /** A `web_grants` table exactly as LAMA-296 created it: UNIQUE on
   *  registration_id (one grant per installation, ever). */
  const LEGACY_WEB_GRANTS_TABLE = `
    CREATE TABLE web_grants (
      id              TEXT PRIMARY KEY,
      grant_hash      TEXT NOT NULL UNIQUE,
      registration_id TEXT NOT NULL UNIQUE REFERENCES mobile_registrations(host_id),
      admin           INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      revoked_at      INTEGER,
      revoked_reason  TEXT
    )`;

  test("initDb drops the legacy UNIQUE(registration_id) on web_grants so a rotation keeps both grants", () => {
    const path = `/tmp/lamasync-mobile-grants-${process.pid}-${Date.now()}.sqlite`;
    const cleanup = (): void => {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    };
    try {
      const seed = new Database(path, { create: true });
      seed.exec(SERVER_SCHEMA);
      seed.exec("DROP TABLE web_grants");
      seed.exec(LEGACY_WEB_GRANTS_TABLE);
      seed.exec("INSERT INTO hosts (id, hostname) VALUES ('host-g', 'pixel')");
      seed.exec(
        `INSERT INTO mobile_registrations
           (host_id, client_type, display_name, app_version, native_token_hash, created_at)
         VALUES ('host-g', 'android', 'Pixel', '1.0.0', 'h-native', ?)`,
        [NOW],
      );
      seed.run(
        `INSERT INTO web_grants (id, grant_hash, registration_id, admin, created_at)
         VALUES ('grant-old', 'h-old-grant', 'host-g', 1, ?)`,
        [NOW],
      );
      // The legacy constraint is real: a second grant is refused.
      expect(() =>
        seed.run(
          `INSERT INTO web_grants (id, grant_hash, registration_id, admin, created_at)
           VALUES ('grant-2', 'h-new-grant', 'host-g', 1, ?)`,
          [NOW],
        ),
      ).toThrow();
      expect(hasUniqueIndexOn(seed, "web_grants", "registration_id")).toBe(true);
      seed.close();

      const db = initDb(path);
      try {
        expect(hasUniqueIndexOn(db, "web_grants", "registration_id")).toBe(false);
        // The historical grant survived…
        const kept = db
          .query<{ id: string; grant_hash: string; admin: number }, []>(
            "SELECT id, grant_hash, admin FROM web_grants",
          )
          .get();
        expect(kept).toEqual({ id: "grant-old", grant_hash: "h-old-grant", admin: 1 });
        // …and the rotation's fresh grant row can coexist with it.
        db.run(
          `INSERT INTO web_grants (id, grant_hash, registration_id, admin, created_at, revoked_at, revoked_reason)
           VALUES ('grant-2', 'h-new-grant', 'host-g', 1, ?, ?, 'credentials rotated by reconnect')`,
          [NOW + 1000, NOW + 1000],
        );
        const grants = db
          .query<{ id: string; revoked_reason: string | null }, []>(
            "SELECT id, revoked_reason FROM web_grants ORDER BY created_at",
          )
          .all();
        expect(grants).toEqual([
          { id: "grant-old", revoked_reason: null },
          { id: "grant-2", revoked_reason: "credentials rotated by reconnect" },
        ]);
        const index = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_web_grants_registration'",
          )
          .get();
        expect(index?.name).toBe("idx_web_grants_registration");
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  });

  /** True when the table carries a UNIQUE index covering exactly `column`. */
  function hasUniqueIndexOn(db: Database, table: string, column: string): boolean {
    const indexes = db
      .query<{ name: string; unique: number }, []>(`PRAGMA index_list(${table})`)
      .all();
    return indexes.some((index) => {
      if (index.unique !== 1) return false;
      return (
        db
          .query<{ name: string }, []>(`PRAGMA index_info(${index.name})`)
          .all()
          .map((c) => c.name)
          .join(",") === column
      );
    });
  }

  /** True when the table carries the legacy UNIQUE(host_id) constraint. */
  function hasUniqueHostIdIndex(db: Database): boolean {
    const indexes = db
      .query<{ name: string; unique: number }, []>("PRAGMA index_list(mobile_enrollments)")
      .all();
    return indexes.some((index) => {
      if (index.unique !== 1) return false;
      return db
        .query<{ name: string }, []>(`PRAGMA index_info(${index.name})`)
        .all()
        .map((c) => c.name)
        .join(",") === "host_id";
    });
  }

  test("initDb rebuilds a legacy UNIQUE(host_id) table once, preserving every row", () => {
    const path = `/tmp/lamasync-mobile-legacy-${process.pid}-${Date.now()}.sqlite`;
    const cleanup = (): void => {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
      }
    };
    try {
      // A database as LAMA-296 left it: schema + legacy enrollment table,
      // one used enrollment that produced host-old.
      const seed = new Database(path, { create: true });
      seed.exec(SERVER_SCHEMA);
      seed.exec("DROP TABLE mobile_enrollments");
      seed.exec(LEGACY_ENROLLMENTS_TABLE);
      expect(hasUniqueHostIdIndex(seed)).toBe(true);
      insertLegacyRow(seed, "legacy-used", "host-old");
      // The legacy constraint is real: a second row for that host is refused.
      expect(() => insertLegacyRow(seed, "legacy-second", "host-old")).toThrow();
      seed.close();

      // Opening it through initDb is the real migration path (SERVER_SCHEMA's
      // CREATE TABLE IF NOT EXISTS cannot alter the table that already exists).
      const db = initDb(path);
      db.close();

      const migrated = initDb(path);
      try {
        const row = migrated
          .query<
            { id: string; host_id: string; kind: string; status: string; web_admin: number },
            []
          >("SELECT id, host_id, kind, status, web_admin FROM mobile_enrollments")
          .get();
        expect(row).toEqual({
          id: "legacy-used",
          host_id: "host-old",
          kind: "new",
          status: "used",
          web_admin: 1,
        });
        expect(hasUniqueHostIdIndex(migrated)).toBe(false);
        // The rebuilt table accepts the reconnect history — the whole point —
        // and keeps the LAMA-337 indexes.
        migrated.run(
          `INSERT INTO mobile_enrollments (id, secret_hash, host_id, kind, status, expires_at, created_at)
           VALUES ('reconnect-1', ?, 'host-old', 'reconnect', 'pending', ?, ?)`,
          ["h-" + "e".repeat(64), NOW + 600_000, NOW],
        );
        // A third open (every boot re-runs SERVER_SCHEMA + MIGRATIONS) must be
        // a no-op that keeps both rows intact.
        const reopened = initDb(path);
        try {
          const count = reopened
            .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM mobile_enrollments")
            .get();
          expect(count?.n).toBe(2);
        } finally {
          reopened.close();
        }
      } finally {
        migrated.close();
      }
    } finally {
      cleanup();
    }
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
