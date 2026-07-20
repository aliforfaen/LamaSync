/**
 * Backup-setup wizard — guide the user through creating a Folder and
 * assigning it to the current host. Mounted from the Local view when the
 * user presses `n`.
 *
 * Step layout (the schedule step inserts an extra "Cron expression" step
 * right after itself when the user picks the "custom" preset):
 *   1. Folder name   — Input  — required
 *   2. Folder type   — Select — sync | backup
 *   3. Local path    — Input  — required
 *   4. Role          — Select — source | target | both
 *   5. Schedule      — Select — preset (custom → step 6)
 *   6. Cron expr     — Input  — only when preset is "custom"
 *   7. Confirm       — Textual summary; Enter applies
 *
 * `onFinish` calls `ctx.api.createFolder(...)` then `assignFolder(...)` for
 * the current host, surfaces a success message through `ctx.setStatus`. Any
 * thrown error is rendered in the wizard's error slot by the runner.
 */
import { Box, Input, Select, Text } from "@opentui/core";
import type { Renderable } from "@opentui/core";

import type { FolderType } from "@lamasync/core";

import { SCHEDULE_PRESETS } from "../app/schedule-presets.ts";
import type { Wizard, WizardStep } from "../app/wizard.ts";
import { WizardRunner } from "../app/wizard.ts";
import type { ViewContext } from "../app/view-manager.ts";

// ---------------------------------------------------------------------------
// Step renderers
// ---------------------------------------------------------------------------

function inputStep(args: {
  title: string;
  field: string;
  prompt: string;
  placeholder: string;
  runner: WizardRunner;
}): WizardStep {
  return {
    title: args.title,
    render: (state) => {
      const initial = String(state[args.field] ?? "");
      const input = Input({
        placeholder: args.placeholder,
      }) as unknown as Renderable & {
        value: string;
        onSubmit: (event: unknown) => void;
      };
      input.value = initial;
      input.onSubmit = () => {
        args.runner.setField(args.field, input.value.trim());
      };
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: args.prompt }),
        input,
      ) as unknown as Renderable;
    },
    validate: (state) => {
      const v = String(state[args.field] ?? "").trim();
      return v.length > 0 ? null : `${args.field} required`;
    },
  };
}

function selectStep(args: {
  title: string;
  field: string;
  prompt: string;
  options: ReadonlyArray<{ name: string; description: string; value: string }>;
  runner: WizardRunner;
  onPick?: (value: string) => void;
}): WizardStep {
  return {
    title: args.title,
    render: (state) => {
      const initial = String(state[args.field] ?? args.options[0]?.value ?? "");
      const initialIdx = Math.max(
        0,
        args.options.findIndex((o) => o.value === initial),
      );
      const select = Select({
        options: [...args.options],
        showDescription: true,
        flexGrow: 1,
        selectedIndex: initialIdx,
      }) as unknown as Renderable & {
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      select.on("itemSelected", (_idx: unknown, option: unknown) => {
        const opt = option as { value: string };
        args.runner.setField(args.field, opt.value);
        args.onPick?.(opt.value);
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: args.prompt }),
        select,
      ) as unknown as Renderable;
    },
    validate: (state) =>
      String(state[args.field] ?? "").length > 0 ? null : `${args.field} required`,
  };
}

function confirmStep(title: string): WizardStep {
  return {
    title,
    render: (state) => summaryRenderable(state),
  };
}

function summaryRenderable(state: Record<string, unknown>): Renderable {
  const lines = [
    `Name:        ${String(state["name"] ?? "(missing)")}`,
    `Type:        ${String(state["type"] ?? "(missing)")}`,
    `Local path:  ${String(state["localPath"] ?? "(missing)")}`,
    `Role:        ${String(state["role"] ?? "(missing)")}`,
    `Schedule:    ${String(state["schedule"] ?? "(none)")}`,
    "",
    "Apply?  Enter to confirm, Esc to go back, q to cancel.",
  ];
  const children: Renderable[] = lines.map((line) =>
    Text({ content: line }) as unknown as Renderable,
  );
  return Box({ flexDirection: "column", gap: 1 }, ...children) as unknown as Renderable;
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/** Index of the schedule step inside the assembled step list. */
const SCHEDULE_INDEX = 4;
/** Title of the dynamically-inserted cron step. */
const CRON_TITLE = "Cron expression";

export function createBackupSetupWizard(opts: { ctx: ViewContext }): Wizard {
  const { ctx } = opts;

  // Construct the runner with empty steps first so the step builders can
  // close over it. We swap in the real steps below.
  const runner = new WizardRunner({
    id: "backup-setup",
    title: "Backup setup",
    steps: [],
  });

  const cronStep: WizardStep = {
    title: CRON_TITLE,
    render: (state) => {
      const initial = String(state["schedule"] ?? "");
      const input = Input({
        placeholder: "0 * * * *  |  @reboot  |  @hourly",
      }) as unknown as Renderable & {
        value: string;
        onSubmit: (event: unknown) => void;
      };
      input.value = initial;
      input.onSubmit = () => {
        runner.setField("schedule", input.value.trim());
      };
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Enter a cron expression." }),
        input,
      ) as unknown as Renderable;
    },
    validate: (state) =>
      String(state["schedule"] ?? "").trim().length > 0
        ? null
        : "cron expression required",
  };

  const steps: WizardStep[] = [
    inputStep({
      title: "Folder name",
      field: "name",
      prompt: "Pick a name for this folder.",
      placeholder: "LamaFiles",
      runner,
    }),
    selectStep({
      title: "Folder type",
      field: "type",
      prompt: "What kind of folder is this?",
      options: [
        { name: "sync", description: "two-way sync between hosts", value: "sync" },
        { name: "backup", description: "one-shot backup", value: "backup" },
      ],
      runner,
    }),
    inputStep({
      title: "Local path",
      field: "localPath",
      prompt: "Local path on this host.",
      placeholder: "/home/user/LamaFiles",
      runner,
    }),
    selectStep({
      title: "Role on this host",
      field: "role",
      prompt: "How does this host use the folder?",
      options: [
        { name: "source", description: "this host originates data", value: "source" },
        { name: "target", description: "this host receives data", value: "target" },
        { name: "both", description: "bidirectional", value: "both" },
      ],
      runner,
    }),
    selectStep({
      title: "Schedule",
      field: "schedulePreset",
      prompt: "How often should this sync run?",
      options: SCHEDULE_PRESETS.map((preset) => ({
        name: preset.label,
        description:
          preset.cron === "" ? "pick to enter a custom cron expr" : preset.cron,
        value: preset.value,
      })),
      runner,
      onPick: (value) => {
        const preset = SCHEDULE_PRESETS.find((p) => p.value === value);
        if (!preset) return;
        if (value === "custom") {
          runner.setSteps([cronStep], SCHEDULE_INDEX + 1);
        } else {
          runner.setField("schedule", preset.cron);
          // If a cron step was previously inserted, remove it so the next
          // step is the Confirm summary.
          const inserted = runner.steps.findIndex(
            (s, i) => i > SCHEDULE_INDEX && s.title === CRON_TITLE,
          );
          if (inserted !== -1) {
            (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = [
              ...runner.steps.slice(0, inserted),
              ...runner.steps.slice(inserted + 1),
            ];
            (runner as unknown as { renderCurrentStep(): void }).renderCurrentStep();
          }
        }
      },
    }),
    confirmStep("Confirm"),
  ];

  // Swap the runner's step list with the fully-wired one.
  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    handleKey: (e) => runner.handleKey(e),
    onCancel: () => {
      ctx.setStatus("Backup setup cancelled", "info");
    },
    onFinish: async (state) => {
      const folder = await ctx.api.createFolder({
        name: String(state["name"]),
        type: String(state["type"]) as FolderType,
        encrypted: false,
        cryptPassword: null,
      });
      await ctx.api.assignFolder(folder.id, {
        folderId: folder.id,
        hostId: ctx.hostname,
        role: String(state["role"]) as "source" | "target" | "both",
        localPath: String(state["localPath"]),
        enabled: true,
        syncExpr: state["schedule"] ? String(state["schedule"]) : null,
      });
      ctx.setStatus(
        `created folder ${state["name"]} and assigned to ${ctx.hostname}`,
        "success",
      );
    },
  };
}