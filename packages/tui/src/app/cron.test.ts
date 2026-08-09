// Pure tests for the wizard cron sanity checker (WS3 / TUI foundations).

import { describe, expect, test } from "bun:test";
import { validateCronExpression } from "./cron.ts";

describe("validateCronExpression", () => {
  test("accepts valid 5-field expressions", () => {
    expect(validateCronExpression("0 * * * *")).toBeNull();
    expect(validateCronExpression("*/15 * * * *")).toBeNull();
    expect(validateCronExpression("0 0 * * 0")).toBeNull();
    expect(validateCronExpression("0 */6 * * *")).toBeNull();
    expect(validateCronExpression("5 4 * * 1-5")).toBeNull();
    expect(validateCronExpression("0,30 9-17 * * *")).toBeNull();
    expect(validateCronExpression("0 12 */2 * *")).toBeNull();
  });

  test("accepts @-keywords", () => {
    expect(validateCronExpression("@reboot")).toBeNull();
    expect(validateCronExpression("@login")).toBeNull();
    expect(validateCronExpression("@hourly")).toBeNull();
    expect(validateCronExpression("@Monthly")).toBeNull();
  });

  test("rejects empty input", () => {
    expect(validateCronExpression("")).toContain("required");
    expect(validateCronExpression("   ")).toContain("required");
  });

  test("rejects wrong field counts", () => {
    expect(validateCronExpression("0 * * *")).toContain("5 fields");
    expect(validateCronExpression("0 * * * * *")).toContain("5 fields");
  });

  test("rejects out-of-range values per field", () => {
    expect(validateCronExpression("60 * * * *")).toContain("out of range");
    expect(validateCronExpression("0 24 * * *")).toContain("out of range");
    expect(validateCronExpression("0 0 32 * *")).toContain("out of range");
    expect(validateCronExpression("0 0 * 13 *")).toContain("out of range");
    expect(validateCronExpression("0 0 * * 8")).toContain("out of range");
  });

  test("rejects malformed tokens", () => {
    expect(validateCronExpression("x * * * *")).toContain("invalid cron token");
    expect(validateCronExpression("*/0 * * * *")).toContain("step");
    expect(validateCronExpression("5-2 * * * *")).toContain("start exceeds");
  });
});
