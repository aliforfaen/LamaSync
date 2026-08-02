// LAMA-222: at-rest encryption for backend secrets (AES-256-GCM).
//
// The key comes from LAMASYNC_SECRET_KEY (>= 16 chars) or a persisted
// random key file at <LAMASYNC_DATA_DIR>/secret.key (0600). The key file is
// created on first use so encryption works with zero configuration; set
// LAMASYNC_SECRET_KEY to pin a key explicitly (e.g. in Docker).
//
// Format: base64(iv(12) || ciphertext || tag(16)). When no key is
// available (misconfigured host, unwritable data dir), encryption falls
// back to base64(plaintext) prefixed with "legacy:" so old deployments
// keep working while operators sort out the key — decryption handles both.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_FILE = "secret.key";
const LEGACY_PREFIX = "legacy:";

function dataDir(): string {
  return process.env.LAMASYNC_DATA_DIR ?? "/data";
}

/** Derive a 32-byte AES key from the env var, or load the persisted key file. */
export function loadSecretKey(): Uint8Array | null {
  const fromEnv = process.env.LAMASYNC_SECRET_KEY;
  if (typeof fromEnv === "string" && fromEnv.length >= 16) {
    return createHash("sha256").update(fromEnv).digest().subarray(0, 32);
  }
  try {
    const file = join(dataDir(), KEY_FILE);
    if (existsSync(file)) {
      const raw = readFileSync(file);
      if (raw.length >= 32) return raw.subarray(0, 32);
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Return the encryption key, creating and persisting a random one on first
 * use. Throws only when no key exists and one cannot be persisted — callers
 * decide whether that's fatal or a plaintext fallback.
 */
export function ensureSecretKey(): Uint8Array {
  const existing = loadSecretKey();
  if (existing) return existing;
  const key = randomBytes(32);
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(join(dataDir(), KEY_FILE), key, { mode: 0o600 });
    return key;
  } catch {
    throw new Error(
      "LAMASYNC_SECRET_KEY is not set and the key file cannot be persisted " +
        `at ${join(dataDir(), KEY_FILE)}`,
    );
  }
}

/** Encrypt a secret at rest. Returns the persisted string form. */
export function encryptSecret(plaintext: string): string {
  let key: Uint8Array;
  try {
    key = ensureSecretKey();
  } catch (error) {
    console.error(`[crypto] ${error instanceof Error ? error.message : String(error)}`);
    // Plaintext fallback keeps the system usable on a misconfigured host.
    return `${LEGACY_PREFIX}${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt a value stored by encryptSecret. Never throws — returns null. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith(LEGACY_PREFIX)) {
    try {
      return Buffer.from(stored.slice(LEGACY_PREFIX.length), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  const key = loadSecretKey();
  if (!key) return null;
  try {
    const buf = Buffer.from(stored, "base64");
    if (buf.length < 12 + 16) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const data = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** True when the stored value is actually encrypted (not the plaintext fallback). */
export function isEncryptedSecret(stored: string | null | undefined): boolean {
  return typeof stored === "string" && !stored.startsWith(LEGACY_PREFIX);
}
