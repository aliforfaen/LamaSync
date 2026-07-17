import { describe, expect, test } from "bun:test";
import { runHook } from "./hooks.ts";

describe("runHook", () => {
  test("empty command is a no-op success", async () => {
    const result = await runHook("", {
      folderId: "f1",
      localPath: "/tmp",
      op: "pre",
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("runs a command and captures output", async () => {
    const result = await runHook("echo hello && echo err >&2", {
      folderId: "f1",
      localPath: "/tmp",
      op: "post",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr.trim()).toBe("err");
    expect(result.timedOut).toBe(false);
  });

  test("times out a hanging command", async () => {
    const result = await runHook(
      "sleep 10",
      { folderId: "f1", localPath: "/tmp", op: "pre" },
      50,
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });
});
