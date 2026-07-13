// Unit tests for the /api/v1/shares route.
//
// We boot a fresh Elysia app per test with `sharesRoutes` mounted and the
// `LAMASYNC_SHARES` env var pre-populated, then assert the response shape
// (and that an unset env yields an empty list).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { loadShares, sharesRoutes } from "./shares.ts";

const ORIGINAL_ENV = process.env.LAMASYNC_SHARES;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.LAMASYNC_SHARES;
  } else {
    process.env.LAMASYNC_SHARES = ORIGINAL_ENV;
  }
});

describe("loadShares", () => {
  beforeEach(() => {
    delete process.env.LAMASYNC_SHARES;
  });

  test("returns [] when env unset and no file present", () => {
    delete process.env.LAMASYNC_SHARES;
    expect(loadShares()).toEqual([]);
  });

  test("parses well-formed LAMASYNC_SHARES env", () => {
    process.env.LAMASYNC_SHARES = JSON.stringify([
      {
        id: "media-archive",
        name: "Media Archive",
        server: "10.0.0.10",
        path: "/srv/media",
        type: "nfs",
        options: "rw,sync,hard",
      },
      {
        id: "home-photos",
        name: "Home Photos",
        server: "nas.local",
        path: "/share/photos",
        type: "smb",
        options: "credentials=/etc/samba/photos.creds,uid=1000",
      },
    ]);
    const shares = loadShares();
    expect(shares).toHaveLength(2);
    expect(shares[0]?.id).toBe("media-archive");
    expect(shares[1]?.type).toBe("smb");
  });

  test("filters out malformed entries", () => {
    process.env.LAMASYNC_SHARES = JSON.stringify([
      {
        id: "good",
        name: "Good",
        server: "10.0.0.1",
        path: "/share",
        type: "nfs",
        options: "defaults",
      },
      // missing required fields
      { id: "bad", type: "nfs" },
      // wrong type
      {
        id: "weird",
        name: "Weird",
        server: "10.0.0.2",
        path: "/share",
        type: "webdav",
        options: "",
      },
    ]);
    const shares = loadShares();
    expect(shares).toHaveLength(1);
    expect(shares[0]?.id).toBe("good");
  });

  test("invalid JSON in env yields empty list (no file fallback in test env)", () => {
    process.env.LAMASYNC_SHARES = "{not json";
    expect(loadShares()).toEqual([]);
  });
});

describe("sharesRoutes", () => {
  test("GET /api/v1/shares returns configured shares", async () => {
    process.env.LAMASYNC_SHARES = JSON.stringify([
      {
        id: "lab",
        name: "Lab NFS",
        server: "10.0.0.20",
        path: "/lab",
        type: "nfs",
        options: "rw,sync",
      },
    ]);
    const app = new Elysia().use(sharesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/shares"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("lab");
    expect(body[0]?.type).toBe("nfs");
  });

  test("GET /api/v1/shares returns [] when nothing configured", async () => {
    delete process.env.LAMASYNC_SHARES;
    const app = new Elysia().use(sharesRoutes);
    const res = await app.handle(
      new Request("http://localhost/api/v1/shares"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});