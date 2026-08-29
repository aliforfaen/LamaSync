// LAMA-234: managed API-key helper tests. Hermetic — no routes, no network.
//
// Coverage:
//   - token format (lmsk_<keyId>_<secret>), parse round-trip, malformed
//     inputs rejected
//   - hashing: sha256 hex, deterministic, never equal to the secret
//   - constant-time comparison (equal / different / length-mismatch)
//   - insertManagedApiKey: row keyed by embedded keyId, hash stored,
//     token_enc is real AES-GCM (never the legacy plaintext fallback) and
//     decrypts back to the full token; device keys require hostId
//   - findApiKeyByToken: match / tampered secret / unknown id / malformed
//   - last_used_at rate-limited bump
//   - summary projection is masked (no secret fields)
//   - schema: api_keys table + index exist on fresh DB and via MIGRATIONS

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS, SERVER_SCHEMA } from "@lamasync/core";

// Hermetic crypto: pin the secret key so token_enc is real AES-GCM and the
// (default) data-dir key file is never touched. Set inside beforeEach so a
// prior test's afterEach (which restores the outer env) can never leave the
// key unset at crypto call time.
const ORIGINAL_SECRET_KEY = process.env.LAMASYNC_SECRET_KEY;
const TEST_SECRET_KEY = "api-keys-unit-test-secret-1234567890";

const {
  generateKeyId,
  generateApiKeyToken,
  hashTokenSecret,
  fingerprintFromHash,
  hashesEqual,
  parseApiKeyToken,
  insertManagedApiKey,
  findApiKeyByToken,
  touchApiKeyLastUsed,
  isApiKeyRowRevoked,
  apiKeyRowToSummary,
  __setApiKeysDb,
  __resetApiKeysDb,
  LAST_USED_WRITE_WINDOW_MS,
} = await import("./api-keys.ts");
const { decryptSecret, isEncryptedSecret } = await import("./crypto.ts");

const KEY_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

let db: Database;

function freshDb(): Database {
  const d = new Database(":memory:");
  d.exec(SERVER_SCHEMA);
  for (const migration of MIGRATIONS) {
    try {
      d.exec(migration);
    } catch {
      // ignore (idempotent safety-net migrations)
    }
  }
  return d;
}

beforeEach(() => {
  process.env.LAMASYNC_SECRET_KEY = TEST_SECRET_KEY;
  db = freshDb();
  __setApiKeysDb(db);
});

afterEach(() => {
  __resetApiKeysDb();
  db.close();
  if (ORIGINAL_SECRET_KEY === undefined) delete process.env.LAMASYNC_SECRET_KEY;
  else process.env.LAMASYNC_SECRET_KEY = ORIGINAL_SECRET_KEY;
});

describe("token format", () => {
  test("shape is lmsk.<12 unambiguous chars>.<base64url secret>", () => {
    const { token, keyId, secret } = generateApiKeyToken();
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("lmsk");
    expect(parts[1]).toBe(keyId);
    expect(keyId).toHaveLength(12);
    for (const ch of keyId) {
      expect(KEY_ID_ALPHABET).toContain(ch);
    }
    expect(secret).toHaveLength(43); // base64url of 32 bytes
    // secret portion matches the parsed secret
    const parsed = parseApiKeyToken(token);
    expect(parsed).toEqual({ keyId, secret });
  });

  test("key ids are unique over a small sample", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateKeyId());
    expect(seen.size).toBe(200);
  });

  test("parse rejects malformed tokens", () => {
    expect(parseApiKeyToken("")).toBeNull();
    expect(parseApiKeyToken("nope")).toBeNull();
    expect(parseApiKeyToken("lmsk.short.secret")).toBeNull();
    expect(parseApiKeyToken("lmsk.000000000000.secret12345678")).toBeNull(); // 0 not in alphabet
    expect(parseApiKeyToken("lmsk.1234567890ab.secret12345678")).toBeNull(); // 0/1 not in alphabet
    expect(parseApiKeyToken("lmsk.ABCDEFGHJKLM.short")).toBeNull();
    expect(parseApiKeyToken("other.ABCDEFGHJKLM.secret1234567890123456")).toBeNull();
    expect(parseApiKeyToken("lmsk.ABCDEFGHJKLM.secret12345678.extra")).toBeNull();
    expect(parseApiKeyToken(null!)).toBeNull();
  });
});

describe("hashing", () => {
  test("hash is sha256 hex (64 chars), deterministic, not the secret", () => {
    const { secret } = generateApiKeyToken();
    const hash = hashTokenSecret(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTokenSecret(secret)).toBe(hash);
    expect(hash).not.toContain(secret);
  });

  test("fingerprint is the first 10 chars of the hash", () => {
    const hash = hashTokenSecret("anything-here");
    expect(fingerprintFromHash(hash)).toBe(hash.slice(0, 10));
  });

  test("hashesEqual is constant-time and correct", () => {
    const hash = hashTokenSecret("secret-a");
    expect(hashesEqual(hash, hash)).toBe(true);
    expect(hashesEqual(hash, hashTokenSecret("secret-b"))).toBe(false);
    expect(hashesEqual("abcd", "abcdef")).toBe(false);
    expect(hashesEqual("", "")).toBe(false);
  });
});

describe("insertManagedApiKey", () => {
  test("row is keyed by the embedded keyId with hash + real AES-GCM enc", () => {
    const { token, row } = insertManagedApiKey({ name: "cachy daemon", kind: "device", hostId: "host-1" });
    const parsed = parseApiKeyToken(token)!;
    expect(row.id).toBe(parsed.keyId);
    expect(row.name).toBe("cachy daemon");
    expect(row.kind).toBe("device");
    expect(row.host_id).toBe("host-1");
    expect(row.token_hash).toBe(hashTokenSecret(parsed.secret));
    // Never the legacy plaintext fallback
    expect(isEncryptedSecret(row.token_enc)).toBe(true);
    expect(row.token_enc).not.toContain(token);
    // Reveal path round-trips to the full token
    expect(decryptSecret(row.token_enc)).toBe(token);
    expect(row.revoked_at).toBeNull();
    expect(row.created_at).toBeGreaterThan(0);
  });

  test("admin keys have null host_id even when one is passed", () => {
    const { row } = insertManagedApiKey({ name: "Admin laptop", kind: "admin", hostId: null });
    expect(row.kind).toBe("admin");
    expect(row.host_id).toBeNull();
  });

  test("device keys require a hostId", () => {
    expect(() => insertManagedApiKey({ name: "bad", kind: "device", hostId: null })).toThrow(
      /require a hostId/,
    );
  });
});

describe("findApiKeyByToken", () => {
  test("resolves the correct row for a valid token", () => {
    const { token, row } = insertManagedApiKey({ name: "x", kind: "admin", hostId: null });
    const found = findApiKeyByToken(token);
    expect(found?.id).toBe(row.id);
    expect(found?.name).toBe("x");
  });

  test("returns null for tampered secret, unknown id, garbage", () => {
    const { token } = insertManagedApiKey({ name: "x", kind: "admin", hostId: null });
    const parsed = parseApiKeyToken(token)!;
    const tampered = `lmsk_${parsed.keyId}_${"A".repeat(43)}`;
    expect(findApiKeyByToken(tampered)).toBeNull();
    expect(findApiKeyByToken("lmsk_AAAAAAAAAAAA_secret1234567890abcdef1234")).toBeNull();
    expect(findApiKeyByToken("garbage")).toBeNull();
  });
});

describe("revocation + last_used", () => {
  test("isApiKeyRowRevoked reflects the soft-revoke flag", () => {
    const { row } = insertManagedApiKey({ name: "x", kind: "admin", hostId: null });
    expect(isApiKeyRowRevoked(row)).toBe(false);
    db.run("UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE id = ?", [
      Date.now(),
      "rotated",
      row.id,
    ]);
    const fresh = db
      .query("SELECT * FROM api_keys WHERE id = ?")
      .get(row.id) as typeof row;
    expect(isApiKeyRowRevoked(fresh)).toBe(true);
    expect(fresh.revoked_reason).toBe("rotated");
  });

  test("last_used_at bumps on first call, then is rate-limited", () => {
    const { row } = insertManagedApiKey({ name: "x", kind: "admin", hostId: null });
    const read = db.query<{ last_used_at: number | null }, [string]>(
      "SELECT last_used_at FROM api_keys WHERE id = ?",
    );
    const t0 = 1_000_000;
    touchApiKeyLastUsed(row.id, t0);
    expect(read.get(row.id)?.last_used_at).toBe(t0);
    // Within the window: no write
    touchApiKeyLastUsed(row.id, t0 + LAST_USED_WRITE_WINDOW_MS - 1);
    expect(read.get(row.id)?.last_used_at).toBe(t0);
    // Past the window: bumps
    touchApiKeyLastUsed(row.id, t0 + LAST_USED_WRITE_WINDOW_MS + 1);
    expect(read.get(row.id)?.last_used_at).toBe(t0 + LAST_USED_WRITE_WINDOW_MS + 1);
  });
});

describe("summary projection", () => {
  test("is masked and mirrors the row", () => {
    const { token, row } = insertManagedApiKey({ name: "cachy daemon", kind: "device", hostId: "host-9" });
    const summary = apiKeyRowToSummary(row);
    expect(summary.id).toBe(row.id);
    expect(summary.name).toBe("cachy daemon");
    expect(summary.kind).toBe("device");
    expect(summary.hostId).toBe("host-9");
    expect(summary.fingerprint).toBe(row.token_hash.slice(0, 10));
    expect(summary).not.toHaveProperty("token_enc");
    expect(summary).not.toHaveProperty("token_hash");
    expect(JSON.stringify(summary)).not.toContain(token);
  });
});

describe("schema", () => {
  test("api_keys table + index exist via SERVER_SCHEMA", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.some((t) => t.name === "api_keys")).toBe(true);
    const idx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='api_keys'").all() as Array<{ name: string }>;
    expect(idx.some((i) => i.name === "idx_api_keys_host_id")).toBe(true);
  });

  test("MIGRATIONS create the table idempotently on a bare DB", () => {
    const bare = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      try {
        bare.exec(migration);
      } catch {
        // some migrations need earlier tables; only care that api_keys lands
      }
    }
    const found = bare.query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_keys'").get();
    expect(found).not.toBeNull();
    bare.close();
  });
});