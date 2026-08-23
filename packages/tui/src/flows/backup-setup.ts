/**
 * Backup-setup wizard — guide the user through creating a Folder and
 * assigning it to the current host. Mounted from the Local/Fleet views when
 * the user presses `w`.
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
import { validateCronExpression } from "../app/cron.ts";
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
  /** Optional custom validator — default is the non-empty check. */
  validate?: (value: string) => string | null;
}): WizardStep {
  return {
    title: args.title,
    render: (state) => {
      const initial = String(state[args.field] ?? "");
      // Real renderable, not a factory proxy — see setup.ts inputStep for
      // the full rationale (proxy property reads break once mounted; Enter
      // arrives as an "enter" event carrying the current text).
      const input = args.runner.realizeNode(
        Input({
          placeholder: args.placeholder,
        }),
      ) as unknown as Renderable & {
        value: string;
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      input.value = initial;
      input.on("enter", (value: unknown) => {
        args.runner.setField(args.field, String(value ?? "").trim());
        args.runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: args.prompt }),
        input,
      ) as unknown as Renderable;
    },
    validate: (state) => {
      const v = String(state[args.field] ?? "").trim();
      if (v.length === 0) return `${args.field} is required`;
      return args.validate?.(v) ?? null;
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
      const select = args.runner.realizeNode(
        Select({
          options: [...args.options],
          showDescription: true,
          flexGrow: 1,
          selectedIndex: initialIdx,
        }),
      ) as unknown as Renderable & {
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      select.on("itemSelected", (_idx: unknown, option: unknown) => {
        const opt = option as { value: string };
        args.runner.setField(args.field, opt.value);
        args.onPick?.(opt.value);
        // Enter on a Select both picks and advances ("[Enter next]").
        args.runner.next();
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

function confirmStep(title: string, runner: WizardRunner): WizardStep {
  return {
    title,
    render: (state) => summaryRenderable(state),
    // No focusable widget on this step — Enter applies (runner.next() on
    // the last step fires onFinish).
    onKey: (name, char) => {
      if (name === "return" || name === "enter" || char === "\r") {
        runner.next();
        return true;
      }
      return false;
    },
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
/** Title of the dynamically-inserted schedule step (custom cron only). */
const CRON_TITLE = "Custom schedule";

export function createBackupSetupWizard(opts: { ctx: ViewContext }): Wizard {
  const { ctx } = opts;

  // Construct the runner with empty steps first so the step builders can
  // close over it. We swap in the real steps below. The renderer makes the
  // modal a real renderable so step swaps render live (LAMA-181).
  const runner = new WizardRunner({
    id: "backup-setup",
    title: "Backup setup",
    steps: [],
    renderer: ctx.renderer,
  });

  const cronStep: WizardStep = {
    title: CRON_TITLE,
    render: (state) => {
      const initial = String(state["schedule"] ?? "");
      const input = runner.realizeNode(
        Input({
          placeholder: "0 * * * *  |  @reboot  |  @hourly",
        }),
      ) as unknown as Renderable & {
        value: string;
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      input.value = initial;
      // "enter" event, not onSubmit — see inputStep above.
      input.on("enter", (value: unknown) => {
        runner.setField("schedule", String(value ?? "").trim());
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Enter a schedule (cron syntax, e.g. 0 * * * *)." }),
        input,
      ) as unknown as Renderable;
    },
    validate: (state) =>
      validateCronExpression(String(state["schedule"] ?? "").trim()),
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
        { name: "sync", description: "two-way sync between devices", value: "sync" },
        { name: "backup", description: "one-shot backup", value: "backup" },
      ],
      runner,
    }),
    inputStep({
      title: "Local path",
      field: "localPath",
      prompt: "Local path on this device.",
      placeholder: "/home/user/LamaFiles",
      runner,
      validate: (value) =>
        value.startsWith("/")
          ? null
          : "localPath must be an absolute path (starts with /)",
    }),
    selectStep({
      title: "Role on this device",
      field: "role",
      prompt: "How does this device use the folder?",
      options: [
        { name: "source", description: "this device originates data", value: "source" },
        { name: "target", description: "this device receives data", value: "target" },
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
    confirmStep("Confirm", runner),
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