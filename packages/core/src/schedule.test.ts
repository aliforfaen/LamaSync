// LAMA-336: the schedule grammar must agree with the daemon's Scheduler, so
// these tests assert both halves: what the validator accepts and what
// `cron-parser` (the daemon's own parser) can actually schedule.

import { describe, expect, test } from "bun:test";
import { CronExpressionParser } from "cron-parser";
import { validateScheduleExpression } from "./schedule.ts";

describe("validateScheduleExpression", () => {
  test("accepts the special tokens the daemon handles itself", () => {
    expect(validateScheduleExpression("@reboot")).toBeNull();
    expect(validateScheduleExpression("@login")).toBeNull();
  });

  test("accepts expressions the daemon's own parser schedules", () => {
    for (const expr of [
      "0 * * * *",
      "*/15 * * * *",
      "0 0 1 * *",
      "0 0 * * 0",
      "@hourly",
      "@daily",
      "@weekly",
      "@monthly",
      "@yearly",
      "@annually",
    ]) {
      expect(validateScheduleExpression(expr)).toBeNull();
      // The daemon feeds non-special expressions straight to this parser.
      expect(() => CronExpressionParser.parse(expr, { currentDate: new Date() })).not.toThrow();
    }
  });

  test("tolerates surrounding whitespace", () => {
    expect(validateScheduleExpression("  0 * * * *  ")).toBeNull();
    expect(validateScheduleExpression(" @reboot ")).toBeNull();
  });

  test("rejects a blank expression (null means unscheduled, not empty)", () => {
    expect(validateScheduleExpression("")).toContain("empty");
    expect(validateScheduleExpression("   ")).toContain("empty");
  });

  test("rejects keywords cron-parser would reject, with a readable message", () => {
    // @midnight / @noon are classic cron aliases that cron-parser does NOT
    // understand, so the daemon would never fire them.
    expect(validateScheduleExpression("@midnight")).toContain("unknown schedule keyword");
    expect(validateScheduleExpression("@noon")).toContain("unknown schedule keyword");
    // cron-parser matches its keywords case-sensitively, so an uppercased
    // keyword is rejected here exactly as the daemon rejects it.
    expect(validateScheduleExpression("@HOURLY")).toContain("unknown schedule keyword");
    expect(validateScheduleExpression("@REBOOT")).toContain("unknown schedule keyword");
  });

  test("rejects field errors cron-parser rejects", () => {
    for (const expr of [
      "60 * * * *",
      "*/0 * * * *",
      "0 0 * * 8",
      "not a cron",
      "0 0 30 2 *",
    ]) {
      expect(validateScheduleExpression(expr)).not.toBeNull();
    }
  });

  test("rejects a field count the daemon's parser would silently reinterpret", () => {
    // cron-parser left-pads missing fields, so a 4-field expression becomes a
    // 6-field one with SECONDS — `* * * *` would capture every second rather
    // than every minute. Accepted must imply schedulable AND intended.
    expect(validateScheduleExpression("* * * *")).toContain("5 fields");
    expect(validateScheduleExpression("* * *")).toContain("5 fields");
    expect(validateScheduleExpression("*/5 * * * * *")).toContain("5 fields");

    // The daemon's own parser is looser than the boundary; the boundary is
    // the stricter of the two on purpose (accepted ⊆ schedulable).
    expect(() => CronExpressionParser.parse("* * * *", { currentDate: new Date() })).not.toThrow();
  });
});
