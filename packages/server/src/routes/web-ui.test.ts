// Server test for the web UI route — verifies GET / returns text/html
// regardless of whether the Vite artifact has been built (the fallback path
// still returns valid HTML so dev/test flows keep working).

import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { webUiRoutes } from "./web-ui.ts";

const app = new Elysia().use(webUiRoutes);

describe("GET / — web UI route (LAMA-147)", () => {
  test("returns HTML", async () => {
    const res = await app.handle(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType.startsWith("text/html")).toBe(true);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body.toLowerCase()).toContain("<!doctype html");
  });

  test("body contains either built artifact or fallback", async () => {
    const res = await app.handle(new Request("http://localhost/"));
    const body = await res.text();
    const isBuilt = body.includes("LamaSync");
    const isFallback = body.includes("Web UI not built");
    expect(isBuilt || isFallback).toBe(true);
  });
});
