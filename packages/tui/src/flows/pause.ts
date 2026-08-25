/**
 * Pause / slow-mode wizard (LAMA-273).
 *
 * One dialog drives both setting and clearing a pause so the Ctrl+P
 * hotkey can open the right flow based on the current state. The active
 * path is decided by `initialMode`:
 *
 *   - "set"    → scope → duration → mode → (slow bwlimit?) → confirm
 *   - "resume" → scope → confirm
 *
 * `scope` accepts "all" (global pause) or "this" (host pause). The
 * `this` row's host id comes from `ctx.hostname` (the local identifier
 * registered with the server).
 *
 * Glossary wording ("devices", "pause", "slow mode") follows
 * `docs/terminology.md`. `onFinish` always returns a `Result` envelope so
 * callers can show a status-bar caption without having to fish the
 * success/error out of a thrown promise.
 */
import { Box, Input, Select, Text } from "@opentui/core";
import type { Renderable } from "@opentui/core";

import type { PauseMode, PauseState } from "@lamasync/core";

import type { Wizard, WizardStep } from "../app/wizard.ts";
import { WizardRunner } from "../app/wizard.ts";
import type { ViewContext } from "../app/view-manager.ts";
import {
  computeUntilMs,
  formatBwlimit,
  formatPauseIndicatorAscii,
  PAUSE_DURATION_PRESETS,
  type PauseDurationPreset,
} from "../pause.ts";
import { friendlyError } from "../friendly-error.ts";

// ---------------------------------------------------------------------------
// Step renderers (mirrors backup-setup.ts / setup.ts conventions)
// ---------------------------------------------------------------------------

interface ScopeChoice {
  name: string;
  description: string;
  value: "all" | "this";
}

const SCOPE_OPTIONS: ReadonlyArray<ScopeChoice> = [
  {
    name: "All devices",
    description: "pause or resume the whole fleet at once",
    value: "all",
  },
  {
    name: "This device",
    description: "pause or resume just this machine",
    value: "this",
  },
];

interface ModeChoice {
  name: string;
  description: string;
  value: "pause" | "slow";
}

const MODE_OPTIONS: ReadonlyArray<ModeChoice> = [
  {
    name: "Pause",
    description: "stop syncs and backups until the pause expires",
    value: "pause",
  },
  {
    name: "Slow mode",
    description: "cap bandwidth (useful on a tethered connection)",
    value: "slow",
  },
];

function scopeStep(runner: WizardRunner, defaultScope: "all" | "this"): WizardStep {
  return {
    title: "Scope",
    render: (state) => {
      const stored = String(state["scope"] ?? defaultScope);
      const initialIdx = Math.max(
        0,
        SCOPE_OPTIONS.findIndex((o) => o.value === stored),
      );
      const select = runner.realizeNode(
        Select({
          options: SCOPE_OPTIONS.map((o) => ({ ...o })),
          showDescription: true,
          flexGrow: 1,
          selectedIndex: initialIdx,
        }),
      ) as unknown as Renderable & {
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      select.on("itemSelected", (_idx: unknown, option: unknown) => {
        const opt = option as { value: "all" | "this" };
        runner.setField("scope", opt.value);
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Which devices should this pause affect?" }),
        select,
      ) as unknown as Renderable;
    },
    validate: (state) =>
      String(state["scope"] ?? "").length > 0 ? null : "scope required",
  };
}

function durationStep(runner: WizardRunner): WizardStep {
  return {
    title: "Duration",
    render: (state) => {
      const stored = String(state["duration"] ?? "1h");
      const initialIdx = Math.max(
        0,
        PAUSE_DURATION_PRESETS.findIndex((p) => p.value === stored),
      );
      const select = runner.realizeNode(
        Select({
          options: PAUSE_DURATION_PRESETS.map((p) => ({ ...p })),
          showDescription: true,
          flexGrow: 1,
          selectedIndex: initialIdx,
        }),
      ) as unknown as Renderable & {
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      select.on("itemSelected", (_idx: unknown, option: unknown) => {
        const opt = option as { value: PauseDurationPreset };
        runner.setField("duration", opt.value);
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "How long should the pause last?" }),
        select,
      ) as unknown as Renderable;
    },
    validate: (state) =>
      String(state["duration"] ?? "").length > 0 ? null : "duration required",
  };
}

function modeStep(
  runner: WizardRunner,
  onPick: (value: "pause" | "slow") => void,
): WizardStep {
  return {
    title: "Mode",
    render: (state) => {
      const stored = String(state["mode"] ?? "pause");
      const initialIdx = Math.max(
        0,
        MODE_OPTIONS.findIndex((o) => o.value === stored),
      );
      const select = runner.realizeNode(
        Select({
          options: MODE_OPTIONS.map((o) => ({ ...o })),
          showDescription: true,
          flexGrow: 1,
          selectedIndex: initialIdx,
        }),
      ) as unknown as Renderable & {
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      select.on("itemSelected", (_idx: unknown, option: unknown) => {
        const opt = option as { value: "pause" | "slow" };
        runner.setField("mode", opt.value);
        // `onPick` runs before `runner.next()` so the caller can mutate
        // the step list (insert / remove the bwlimit step) without
        // racing the runner's index advance — mirrors backup-setup.ts.
        onPick(opt.value);
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: "Pause or slow mode?" }),
        select,
      ) as unknown as Renderable;
    },
    validate: (state) =>
      String(state["mode"] ?? "").length > 0 ? null : "mode required",
  };
}

function bwlimitStep(runner: WizardRunner): WizardStep {
  return {
    title: "Bandwidth limit",
    render: (state) => {
      const initial = String(state["bwlimit"] ?? "1M");
      const input = runner.realizeNode(
        Input({ placeholder: "1M" }),
      ) as unknown as Renderable & {
        value: string;
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      input.value = initial;
      input.on("enter", (value: unknown) => {
        runner.setField("bwlimit", String(value ?? "").trim());
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({
          content:
            "rclone size (e.g. 1M, 512K). One segment only — no schedules.",
        }),
        input,
      ) as unknown as Renderable;
    },
    validate: (state) => {
      const bw = String(state["bwlimit"] ?? "").trim();
      if (bw.length === 0) return "bwlimit is required for slow mode";
      // Mirrors the server-side regex (routes/pause.ts): a single-segment
      // rclone size like "1M" or "512K". Keeping the rule local keeps the
      // dialog from bouncing on a 4xx for obvious typos.
      if (!/^\d+(?:\.\d+)?[KMGT]?$/i.test(bw)) {
        return "bwlimit must look like '1M' or '512K' (no schedules)";
      }
      return null;
    },
  };
}

function summaryRenderable(state: Record<string, unknown>): Renderable {
  const isResume = state["__initialMode"] === "resume";
  const scope = String(state["scope"] ?? "(unset)");
  const duration = String(state["duration"] ?? "(unset)");
  const mode = String(state["mode"] ?? "(unset)");
  const bwlimit = formatBwlimit(String(state["bwlimit"] ?? ""));
  const lines: string[] = [];
  if (isResume) {
    lines.push(`Resume:    ${scope === "all" ? "all devices" : "this device"}`);
    lines.push("");
    lines.push("Apply?  Enter to confirm, Esc to go back, q to cancel.");
  } else {
    const bwSegment = mode === "slow" && bwlimit ? ` (bandwidth: ${bwlimit})` : "";
    lines.push(`Scope:     ${scope === "all" ? "all devices" : "this device"}`);
    lines.push(`Duration:  ${duration}`);
    lines.push(`Mode:      ${mode}${bwSegment}`);
    lines.push("");
    lines.push("Apply?  Enter to confirm, Esc to go back, q to cancel.");
  }
  const children: Renderable[] = lines.map((line) =>
    Text({ content: line }) as unknown as Renderable,
  );
  return Box({ flexDirection: "column", gap: 1 }, ...children) as unknown as Renderable;
}

function confirmStep(runner: WizardRunner): WizardStep {
  return {
    title: "Confirm",
    render: (state) => summaryRenderable(state),
    // No focusable widget on this step — Enter applies (the runner's next()
    // on the last step fires onFinish, which performs the API call).
    onKey: (name, char) => {
      if (name === "return" || name === "enter" || char === "\r") {
        runner.next();
        return true;
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Flow factory
// ---------------------------------------------------------------------------

export type PauseDialogMode = "set" | "resume";

export interface PauseWizardOpts {
  ctx: ViewContext;
  /** "set" walks the full pause-creation flow; "resume" jumps straight to
   *  the scope + confirm step pair (no duration/mode/bwlimit). */
  mode: PauseDialogMode;
  /** Current pause snapshot from `getPause()`. Used to pre-select the
   *  matching scope so a resume defaults to clearing the active row. */
  current: { global: PauseState | null; hosts: PauseState[] };
}

/** Build the pause wizard. Always returns a `Wizard` the caller can hand to
 *  `ctx.openWizard` — the runner / onFinish flow is constructed lazily so
 *  the modal mounts only once the Shell wires it through. */
export function createPauseWizard(opts: PauseWizardOpts): Wizard {
  const { ctx, mode, current } = opts;
  const localHostId = ctx.hostname;

  // Resume scope default: if the local host has its own row, target "this";
  // otherwise "all". This keeps the dialog aligned with what the user just
  // saw in the status bar — picking the obvious row instead of forcing a
  // re-pick.
  const hostRow = current.hosts.find((row) => row.hostId === localHostId) ?? null;
  const hasActiveHost = hostRow !== null;
  const hasActiveGlobal = current.global !== null;
  const defaultScope: "all" | "this" =
    mode === "resume"
      ? hasActiveHost
        ? "this"
        : hasActiveGlobal
          ? "all"
          : "this"
      : "all";

  const runner = new WizardRunner({
    id: "pause",
    title: mode === "set" ? "Pause syncs" : "Resume syncs",
    steps: [],
    renderer: ctx.renderer,
  });

  const steps: WizardStep[] =
    mode === "set"
      ? [
          scopeStep(runner, defaultScope),
          durationStep(runner),
          // `modeStep` inserts the bwlimit step on slow picks via the
          // onPick callback below; for "pause" picks we strip a stale
          // bwlimit step (if the user backed up and re-picked pause)
          // so the runner lands on the right next slot. Mirrors
          // backup-setup.ts's cron-step dance — same approval (LAMA-173).
          modeStep(runner, (value) => {
            const modeIdx = steps.findIndex((s) => s.title === "Mode");
            const confirmIdx = steps.findIndex((s) => s.title === "Confirm");
            if (modeIdx === -1 || confirmIdx === -1) return;
            if (value === "slow") {
              runner.setSteps([bwlimitStep(runner)], confirmIdx);
              return;
            }
            // "pause": strip a stale bwlimit step if present so Confirm
            // becomes the next step again.
            const bwIdx = (runner.steps as ReadonlyArray<WizardStep>).findIndex(
              (s, i) => i > modeIdx && s.title === "Bandwidth limit",
            );
            if (bwIdx !== -1) {
              (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps =
                [
                  ...(runner.steps as ReadonlyArray<WizardStep>).slice(0, bwIdx),
                  ...(runner.steps as ReadonlyArray<WizardStep>).slice(bwIdx + 1),
                ];
            }
          }),
          confirmStep(runner),
        ]
      : [scopeStep(runner, defaultScope), confirmStep(runner)];

  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    handleKey: (e) => runner.handleKey(e),
    onCancel: () => {
      ctx.setStatus(
        mode === "set" ? "Pause cancelled" : "Resume cancelled",
        "info",
      );
    },
    onFinish: async (state) => {
      const scope = String(state["scope"] ?? "");
      const onHost = scope === "this";
      try {
        if (mode === "resume") {
          if (onHost) {
            await ctx.api.clearHostPause(localHostId);
          } else {
            await ctx.api.clearPause();
          }
          ctx.setStatus(
            onHost ? "Resumed this device" : "Resumed all devices",
            "success",
          );
          return;
        }
        const duration = String(state["duration"] ?? "1h") as PauseDurationPreset;
        const until = computeUntilMs(duration, Date.now());
        const modeChoice = String(state["mode"] ?? "pause") as PauseMode;
        const bwlimit =
          modeChoice === "slow"
            ? formatBwlimit(String(state["bwlimit"] ?? "")) ?? null
            : null;
        const body = {
          until: new Date(until).toISOString(),
          mode: modeChoice,
          bwlimit,
        };
        const applied = onHost
          ? await ctx.api.setHostPause(localHostId, body)
          : await ctx.api.setPause(body);
        ctx.setStatus(
          formatPauseIndicatorAscii(applied, Date.now()) +
            (onHost ? " · this device" : " · all devices"),
          "success",
        );
      } catch (err) {
        const msg = friendlyError(err);
        // Wizard errors live in the runner's error slot when thrown from
        // onFinish — surface a status-bar message too so the user has
        // feedback after the modal closes.
        ctx.setStatus(`pause failed: ${msg}`, "error");
      }
    },
  };
}