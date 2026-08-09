/**
 * Dotfile-manifest wizard — guide the user through creating a new
 * dotfile manifest. Mounted from the Dotfiles view when the user presses
 * `n`.
 *
 * Step layout:
 *   1. App name      — Input  — required
 *   2. Host          — Select — <global> + each host from getHealth().hosts
 *                              (falls back to a Text-only "[fetch failed]"
 *                              message if the API is unreachable)
 *   3. Paths         — Input  — comma-separated, required
 *   4. Excludes      — Input  — comma-separated, optional
 *   5. Schedule      — Select — preset (custom → step 6)
 *   6. Cron expr     — Input  — only when preset is "custom"
 *   7. Instructions  — Input  — optional free text
 *   8. Confirm       — Textual summary; Enter applies
 *
 * `onFinish` calls `ctx.api.createDotfileManifest(...)` and surfaces the
 */
import { Box, Input, Select, Text } from "@opentui/core";
import type { KeyEvent, Renderable } from "@opentui/core";

import type { DotfileManifest } from "@lamasync/core";

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
  required: boolean;
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
      if (!args.required) return null;
      return v.length > 0 ? null : `${args.field} required`;
    },
  };
}

function hostSelectStep(args: {
  runner: WizardRunner;
}): WizardStep {
  return {
    title: "Host",
    render: (state) => {
      const failed = Boolean(state["_hostFetchFailed"]);
      if (failed) {
        return Box(
          { flexDirection: "column", gap: 1 },
          Text({ content: "Host" }),
          Text({ content: "[fetch failed — default to global]" }),
        ) as unknown as Renderable;
      }
      const hosts = Array.isArray(state["_hosts"]) ? (state["_hosts"] as Array<{ id: string; hostname: string }>) : [];
      const options = [
        { name: "<global>", description: "all hosts", value: "_global" },
        ...hosts.map((h) => ({
          name: h.hostname,
          description: h.id,
          value: h.id,
        })),
      ];
      const initial = String(state["hostId"] ?? "_global");
      const initialIdx = Math.max(0, options.findIndex((o) => o.value === initial));
      const select = args.runner.realizeNode(
        Select({
          options,
          showDescription: true,
          flexGrow: 1,
          selectedIndex: initialIdx,
        }),
      ) as unknown as Renderable & {
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      select.on("itemSelected", (_idx: unknown, option: unknown) => {
        const opt = option as { value: string };
        args.runner.setField("hostId", opt.value);
        // Enter on a Select both picks and advances ("[Enter next]").
        args.runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Which host owns this manifest?" }),
        select,
      ) as unknown as Renderable;
    },
    validate: (state) => {
      const failed = Boolean(state["_hostFetchFailed"]);
      if (failed) return null; // default to _global
      return String(state["hostId"] ?? "").length > 0 ? null : "host required";
    },
    // The fetch-failed branch renders no focusable widget, so Enter must be
    // handled here. When the Select rendered, it consumes Enter itself —
    // handling it here too would advance before the selection lands.
    onKey: (name, char, state) => {
      if (!state["_hostFetchFailed"]) return false;
      if (name === "return" || name === "enter" || char === "\r") {
        args.runner.next();
        return true;
      }
      return false;
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
  const hostId = String(state["hostId"] ?? "_global");
  const hostDisplay = hostId === "_global" ? "<global>" : hostId;
  const lines = [
    `App name:    ${String(state["appName"] ?? "(missing)")}`,
    `Host:        ${hostDisplay}`,
    `Paths:       ${String(state["pathsRaw"] ?? "(missing)")}`,
    `Excludes:    ${String(state["excludesRaw"] ?? "(none)")}`,
    `Schedule:    ${String(state["schedule"] ?? "(none)")}`,
    `Instructions:${String(state["instructions"] ?? "(none)")}`,
    "",
    "Apply?  Enter to confirm, Esc to go back, q to cancel.",
  ];
  const children: Renderable[] = lines.map((line) =>
    Text({ content: line }) as unknown as Renderable,
  );
  return Box({ flexDirection: "column", gap: 1 }, ...children) as unknown as Renderable;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function csvSplit(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/** Index of the schedule step inside the assembled step list. */
const SCHEDULE_INDEX = 4;
/** Title of the dynamically-inserted cron step. */
const CRON_TITLE = "Cron expression";

export function createDotfileManifestWizard(opts: { ctx: ViewContext }): Wizard {
  const { ctx } = opts;

  const runner = new WizardRunner({
    id: "dotfile-manifest",
    title: "Dotfile manifest",
    steps: [],
    renderer: ctx.renderer,
  });

  // Kick off the host fetch in the background; the host step reads the
  // result from `state._hosts` / `state._hostFetchFailed` at render time.
  ctx.api
    .getHealth()
    .then((health) => {
      runner.setField("_hosts", health.hosts);
      runner.setField("_hostFetchFailed", false);
    })
    .catch(() => {
      runner.setField("_hostFetchFailed", true);
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
      title: "App name",
      field: "appName",
      prompt: "Pick a name for this manifest.",
      placeholder: "nvim",
      runner,
      required: true,
    }),
    hostSelectStep({ runner }),
    inputStep({
      title: "Paths",
      field: "pathsRaw",
      prompt: "Comma-separated list of paths.",
      placeholder: "~/.config/nvim, ~/.vim",
      runner,
      required: true,
    }),
    inputStep({
      title: "Excludes",
      field: "excludesRaw",
      prompt: "Comma-separated list of excludes (optional).",
      placeholder: "*.swp, .netrw",
      runner,
      required: false,
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
    inputStep({
      title: "Instructions",
      field: "instructions",
      prompt: "Free-form instructions (optional).",
      placeholder: "Run :PlugInstall after restore",
      runner,
      required: false,
    }),
    confirmStep("Confirm", runner),
  ];

  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    handleKey: (e: KeyEvent) => runner.handleKey(e),
    onCancel: () => {
      ctx.setStatus("Dotfile manifest wizard cancelled", "info");
    },
    onFinish: async (state) => {
      const hostId = String(state["hostId"] ?? "_global");
      const paths = csvSplit(String(state["pathsRaw"] ?? ""));
      const excludesRaw = String(state["excludesRaw"] ?? "").trim();
      const excludes = excludesRaw.length > 0 ? csvSplit(excludesRaw) : null;
      const scheduleRaw = state["schedule"];
      const schedule =
        typeof scheduleRaw === "string" && scheduleRaw.length > 0
          ? scheduleRaw
          : null;
      const instructionsRaw = String(state["instructions"] ?? "").trim();
      const instructions =
        instructionsRaw.length > 0 ? instructionsRaw : null;

      await ctx.api.createDotfileManifest({
        appName: String(state["appName"] ?? ""),
        hostId,
        paths,
        excludes,
        schedule,
        instructions,
      } satisfies Omit<DotfileManifest, "id">);

      ctx.setStatus(
        `created dotfile manifest ${state["appName"]}`,
        "success",
      );
    },
  };
}