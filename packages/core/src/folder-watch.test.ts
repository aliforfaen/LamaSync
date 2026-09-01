// LAMA-302: watch-configuration helper tests (defaults, quiet-period
// validation, normalization). Keep pure — no filesystem, no timer.

import { describe, expect, test } from "bun:test";
import {
  WATCH_QUIET_SEC_DEFAULT,
  WATCH_QUIET_SEC_MAX,
  WATCH_QUIET_SEC_MIN,
  isValidWatchQuietSec,
  normalizeWatchQuietSec,
  resolveWatchQuietSec,
} from "./folder-watch.ts";

describe("resolveWatchQuietSec", () => {
  test("maps null / undefined to the 30 s default", () => {
    expect(resolveWatchQuietSec(null)).toBe(WATCH_QUIET_SEC_DEFAULT);
    expect(resolveWatchQuietSec(undefined)).toBe(WATCH_QUIET_SEC_DEFAULT);
  });

  test("maps non-positive or non-finite values to the default", () => {
    expect(resolveWatchQuietSec(0)).toBe(WATCH_QUIET_SEC_DEFAULT);
    expect(resolveWatchQuietSec(-5)).toBe(WATCH_QUIET_SEC_DEFAULT);
    expect(resolveWatchQuietSec(Number.NaN)).toBe(WATCH_QUIET_SEC_DEFAULT);
    expect(resolveWatchQuietSec(Number.POSITIVE_INFINITY)).toBe(
      WATCH_QUIET_SEC_DEFAULT,
    );
  });

  test("clamps out-of-range values to the validated bounds", () => {
    expect(resolveWatchQuietSec(5)).toBe(WATCH_QUIET_SEC_MIN);
    expect(resolveWatchQuietSec(400)).toBe(WATCH_QUIET_SEC_MAX);
  });

  test("truncates fractional seconds", () => {
    expect(resolveWatchQuietSec(30.9)).toBe(30);
  });

  test("passes through in-range integers", () => {
    expect(resolveWatchQuietSec(10)).toBe(10);
    expect(resolveWatchQuietSec(300)).toBe(300);
    expect(resolveWatchQuietSec(60)).toBe(60);
  });
});

describe("isValidWatchQuietSec", () => {
  test("accepts null (=> default)", () => {
    expect(isValidWatchQuietSec(null)).toBe(true);
  });

  test("accepts the inclusive bounds", () => {
    expect(isValidWatchQuietSec(WATCH_QUIET_SEC_MIN)).toBe(true);
    expect(isValidWatchQuietSec(WATCH_QUIET_SEC_MAX)).toBe(true);
    expect(isValidWatchQuietSec(30)).toBe(true);
  });

  test("rejects out-of-range, fractional, and non-finite values", () => {
    expect(isValidWatchQuietSec(9)).toBe(false);
    expect(isValidWatchQuietSec(301)).toBe(false);
    expect(isValidWatchQuietSec(30.5)).toBe(false);
    expect(isValidWatchQuietSec(Number.NaN)).toBe(false);
  });
});

describe("normalizeWatchQuietSec", () => {
  test("null / undefined -> null (stored as the column default)", () => {
    expect(normalizeWatchQuietSec(null)).toBeNull();
    expect(normalizeWatchQuietSec(undefined)).toBeNull();
  });

  test("in-range integer -> itself", () => {
    expect(normalizeWatchQuietSec(30)).toBe(30);
    expect(normalizeWatchQuietSec(120)).toBe(120);
  });

  test("invalid -> null (never persists a garbage number)", () => {
    expect(normalizeWatchQuietSec(3)).toBeNull();
    expect(normalizeWatchQuietSec(999)).toBeNull();
    expect(normalizeWatchQuietSec(30.5)).toBeNull();
    expect(normalizeWatchQuietSec("30")).toBeNull();
  });
});
