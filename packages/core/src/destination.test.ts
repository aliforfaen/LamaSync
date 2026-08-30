import { describe, expect, test } from "bun:test";
import {
  canonicalDestinationKey,
  defaultDestination,
  normalizeDestination,
  resolveDestination,
} from "./destination.ts";
import type { Folder, FolderAssignment } from "./types.ts";

function folder(partial: Partial<Folder>): Folder {
  return {
    id: "f1",
    name: "folder1",
    type: "sync",
    ...partial,
  } as Folder;
}

function assignment(partial: Partial<FolderAssignment>): FolderAssignment {
  return {
    id: "a1",
    folderId: "f1",
    hostId: "host-a",
    role: "both",
    localPath: "/tmp/f1",
    enabled: true,
    ...partial,
  } as FolderAssignment;
}

describe("resolveDestination (LAMA-294)", () => {
  test("normalizes equivalent prefixes and rejects escapes", () => {
    expect(normalizeDestination(" shared//folder/ ")).toBe("shared/folder");
    expect(normalizeDestination("shared\\folder")).toBe("shared/folder");
    expect(normalizeDestination("/absolute")).toBeNull();
    expect(normalizeDestination("shared/../other")).toBeNull();
  });

  test("ordinary backups are host-scoped by default", () => {
    const f = folder({ type: "backup" });
    expect(resolveDestination(f, assignment({ hostId: "host-a" }))).toBe(
      "folder1/host-a",
    );
    expect(resolveDestination(f, assignment({ hostId: "host-b" }))).toBe(
      "folder1/host-b",
    );
  });

  test("sync/mount destinations stay shared (folder name)", () => {
    const f = folder({ type: "sync" });
    expect(resolveDestination(f, assignment({ hostId: "host-a" }))).toBe("folder1");
    expect(resolveDestination(f, assignment({ hostId: "host-b" }))).toBe("folder1");
  });

  test("explicit destination wins over the default", () => {
    expect(
      resolveDestination(folder({ type: "backup" }), assignment({ destination: "shared" })),
    ).toBe("shared");
  });

  test("defaultDestination mirrors resolveDestination without an override", () => {
    expect(defaultDestination(folder({ type: "backup" }), assignment({ hostId: "host-a" }))).toBe("folder1/host-a");
    expect(defaultDestination(folder({ type: "mount" }), assignment({ hostId: "host-a" }))).toBe("folder1");
  });
});

describe("canonicalDestinationKey (LAMA-294)", () => {
  test("distinct hosts with ordinary backups derive distinct keys (concurrent)", () => {
    const f = folder({ type: "backup" });
    const a = canonicalDestinationKey(f, assignment({ hostId: "host-a" }));
    const b = canonicalDestinationKey(f, assignment({ hostId: "host-b" }));
    expect(a).not.toBe(b);
  });

  test("same sync destination collapses across hosts (serialized)", () => {
    const f = folder({ type: "sync" });
    const a = canonicalDestinationKey(f, assignment({ hostId: "host-a" }));
    const b = canonicalDestinationKey(f, assignment({ hostId: "host-b" }));
    expect(a).toBe(b);
  });

  test("two folder ids sharing an explicit destination serialize", () => {
    const src = folder({ id: "f1", name: "folder1", type: "backup", backendId: "be1", backend: "s3" });
    const other = folder({ id: "f2", name: "folder2", type: "backup", backendId: "be1", backend: "s3" });
    const a = canonicalDestinationKey(src, assignment({ hostId: "host-a", destination: "shared" }));
    const b = canonicalDestinationKey(other, assignment({ hostId: "host-b", destination: "shared" }));
    expect(a).toBe(b);
  });

  test("same backend, distinct prefixes run concurrently", () => {
    const src = folder({ id: "f1", name: "folder1", type: "backup", backendId: "be1", backend: "s3" });
    const other = folder({ id: "f2", name: "folder2", type: "backup", backendId: "be1", backend: "s3" });
    const a = canonicalDestinationKey(src, assignment({ hostId: "host-a" }));
    const b = canonicalDestinationKey(other, assignment({ hostId: "host-a" }));
    expect(a).not.toBe(b);
  });

  test("restic repositories are their own serialization unit", () => {
    const f = folder({ type: "backup" });
    const a = canonicalDestinationKey(f, assignment({ hostId: "host-a", resticRepository: "/repo/a" }));
    const b = canonicalDestinationKey(f, assignment({ hostId: "host-b", resticRepository: "/repo/a" }));
    const c = canonicalDestinationKey(f, assignment({ hostId: "host-a", resticRepository: "/repo/b" }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("different S3 buckets do not share a lock key", () => {
    const a = canonicalDestinationKey(
      folder({ type: "backup", backend: "s3", backendId: "be1", s3Bucket: "one" }),
      assignment({ destination: "shared" }),
    );
    const b = canonicalDestinationKey(
      folder({ type: "backup", backend: "s3", backendId: "be1", s3Bucket: "two" }),
      assignment({ destination: "shared" }),
    );
    expect(a).not.toBe(b);
  });

  test("different legacy remote aliases do not share a lock key", () => {
    const a = canonicalDestinationKey(
      folder({ type: "backup", backend: "sftp" }),
      assignment({ remoteName: "remote-a", destination: "shared" }),
    );
    const b = canonicalDestinationKey(
      folder({ type: "backup", backend: "sftp" }),
      assignment({ remoteName: "remote-b", destination: "shared" }),
    );
    expect(a).not.toBe(b);
  });
});
