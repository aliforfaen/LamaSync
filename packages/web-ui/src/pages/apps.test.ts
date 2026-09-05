// LAMA-316 — focused tests for the App templates + App backups page flows.
// The pages keep their interactive behavior in exported flow helpers that
// the buttons call, so bun:test can drive the exact production code without
// a DOM environment (repo convention: no jsdom/@testing-library — see
// BrandLockup.test.tsx / Confetti.test.tsx for the stub style).

import { describe, expect, test } from "bun:test";
import type {
  ApplicationTemplate,
  CaptureSpec,
  CaptureSpecPath,
} from "@lamasync/core";
import {
  runTemplateEnrollment,
  tryDeleteTemplate,
  type TemplateCardData,
  type TemplateCreatePayload,
  type TemplateEnrollServices,
} from "./Presets.tsx";
import {
  setProtectionEnabled,
  uploadProtectionSnapshot,
  UPLOAD_DESCRIPTION,
} from "./Dotfiles.tsx";

type EnrollCall = {
  templateId: string;
  hostId: string;
  schedule?: string | null;
  name?: string;
};

function specOf(linux: string[]): CaptureSpec {
  return {
    paths: {
      linux: linux.map(
        (path): CaptureSpecPath => ({ path, classification: "unknown" }),
      ),
    },
    excludes: [],
    notes: null,
  };
}

function templateCard(over: Partial<TemplateCardData> = {}): TemplateCardData {
  return {
    id: "tpl-1",
    origin: "custom",
    name: "Neovim",
    description: "Editor config",
    emoji: "✦",
    color: "#5dd6c0",
    spec: specOf(["~/.config/nvim"]),
    installUrl: null,
    installInstructions: null,
    restoreInstructions: null,
    revision: 1,
    ...over,
  };
}

function templateRow(over: Partial<ApplicationTemplate> = {}): ApplicationTemplate {
  return {
    id: "tpl-1",
    name: "Neovim",
    origin: "custom",
    description: null,
    emoji: null,
    color: null,
    paths: specOf(["~/.config/nvim"]),
    installUrl: null,
    installInstructions: null,
    restoreInstructions: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function recordServices(
  onEnroll: (body: EnrollCall) => Promise<unknown> = async () => ({}),
): { services: TemplateEnrollServices; enrollCalls: EnrollCall[] } {
  const enrollCalls: EnrollCall[] = [];
  const services: TemplateEnrollServices = {
    listAppTemplates: async () => [],
    createAppTemplate: async (_body: TemplateCreatePayload) => {
      throw new Error("unexpected createAppTemplate in this test");
    },
    enrollAppProtection: async (body) => {
      enrollCalls.push(body);
      return onEnroll(body);
    },
  };
  return { services, enrollCalls };
}

describe("App templates — enrollment flow", () => {
  test("passes the chosen host (plus optional name/schedule) to enrollAppProtection", async () => {
    const { services, enrollCalls } = recordServices();
    const message = await runTemplateEnrollment(services, {
      template: templateCard(),
      hostId: "host-b",
      name: "Laptop nvim",
      schedule: "0 */6 * * *",
    });

    expect(message).toBeNull();
    expect(enrollCalls).toEqual([
      {
        templateId: "tpl-1",
        hostId: "host-b",
        name: "Laptop nvim",
        schedule: "0 */6 * * *",
      },
    ]);
  });

  test("omits optional name/schedule when not supplied", async () => {
    const { services, enrollCalls } = recordServices();
    const message = await runTemplateEnrollment(services, {
      template: templateCard(),
      hostId: "host-a",
    });

    expect(message).toBeNull();
    expect(enrollCalls).toEqual([{ templateId: "tpl-1", hostId: "host-a" }]);
  });

  test("a built-in starter is materialized into a custom template exactly once, then reused", async () => {
    let materialized = false;
    const enrollCalls: EnrollCall[] = [];
    const createCalls: TemplateCreatePayload[] = [];
    const services: TemplateEnrollServices = {
      listAppTemplates: async () => (materialized ? [templateRow()] : []),
      createAppTemplate: async (body) => {
        createCalls.push(body);
        materialized = true;
        return templateRow();
      },
      enrollAppProtection: async (body) => {
        enrollCalls.push(body);
        return { id: "protection-1" };
      },
    };
    const starter = templateCard({ id: null, origin: "built_in" });

    expect(await runTemplateEnrollment(services, { template: starter, hostId: "h1" })).toBeNull();
    expect(await runTemplateEnrollment(services, { template: starter, hostId: "h1" })).toBeNull();

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ name: "Neovim" });
    // Both enrollments target the real template id, never a starter id.
    expect(enrollCalls).toEqual([
      { templateId: "tpl-1", hostId: "h1" },
      { templateId: "tpl-1", hostId: "h1" },
    ]);
  });

  test("a duplicate (host, template) enrollment surfaces the server's 409 message", async () => {
    const { services } = recordServices(async () => {
      throw Object.assign(
        new Error("protection already exists for this host and template"),
        { status: 409 },
      );
    });

    const message = await runTemplateEnrollment(services, {
      template: templateCard(),
      hostId: "host-a",
    });

    expect(message).toBe("protection already exists for this host and template");
  });
});

describe("App templates — delete flow", () => {
  test("returns null on success and surfaces the 409 on active protections", async () => {
    const ok = await tryDeleteTemplate(
      { deleteAppTemplate: async () => undefined },
      "tpl-1",
    );
    expect(ok).toBeNull();

    const conflict = await tryDeleteTemplate(
      {
        deleteAppTemplate: async () => {
          throw Object.assign(new Error("template has active protections"), { status: 409 });
        },
      },
      "tpl-1",
    );
    expect(conflict).toBe("template has active protections");
  });
});

describe("App backups — snapshot upload flow", () => {
  const file = new Blob(["tarball-bytes"]);

  test("uploads against the chosen protection with the page's default description", async () => {
    const calls: Array<{
      protectionId: string;
      file: Blob;
      opts?: { description?: string };
    }> = [];
    const message = await uploadProtectionSnapshot(
      {
        uploadAppSnapshot: async (protectionId, uploaded, opts) => {
          calls.push({ protectionId, file: uploaded, opts });
          return { id: "snap-1" };
        },
      },
      "protection-1",
      file,
    );

    expect(message).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].protectionId).toBe("protection-1");
    expect(calls[0].opts).toEqual({ description: UPLOAD_DESCRIPTION });
  });

  test("uploading to a disabled protection surfaces the server's 409 message", async () => {
    const message = await uploadProtectionSnapshot(
      {
        uploadAppSnapshot: async () => {
          throw Object.assign(new Error("protection is disabled"), { status: 409 });
        },
      },
      "protection-disabled",
      file,
    );

    expect(message).toBe("protection is disabled");
  });
});

describe("App backups — enable/disable flow", () => {
  test("toggles the protection's enabled flag via updateAppProtection", async () => {
    const calls: Array<{ id: string; enabled: boolean }> = [];
    const message = await setProtectionEnabled(
      {
        updateAppProtection: async (id, body) => {
          calls.push({ id, enabled: body.enabled });
          return { id };
        },
      },
      "protection-1",
      false,
    );

    expect(message).toBeNull();
    expect(calls).toEqual([{ id: "protection-1", enabled: false }]);
  });
});
