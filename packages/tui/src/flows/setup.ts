/**
 * First-run setup flow (WS3 / TUI foundations) — replaces the silent
 * localhost:8080 + dev-key defaults with a guided flow the first time the
 * TUI boots without any credentials. Uses the same WizardRunner pattern as
 * `flows/backup-setup.ts`.
 *
 * Steps:
 *   1. Server URL  — Input  — prefilled http://localhost:8080
 *   2. API key     — Input  — stored plain in client.toml (never echoed in
 *                    the confirm summary)
 *   3. Hostname    — Input  — prefilled with os.hostname()
 *   4. Confirm     — summary; Enter writes ~/.config/lamasync/client.toml
 *
 * `q` on any step (or Esc on the first) cancels the flow — the caller then
 * proceeds with the default client plus a warning status.
 */
import { Box, Input, Text } from "@opentui/core";
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import { hostname as osHostname } from "os";

import { WizardRunner, openWizard } from "../app/wizard.ts";
import type { Wizard, WizardStep } from "../app/wizard.ts";
import { DEFAULT_URL } from "../api.ts";

export type SetupOutcome = "saved" | "skipped";

export interface SetupConfig {
  serverUrl: string;
  apiKey: string;
  hostname: string;
}

/** Handles so the caller can mount the runner's modal and drive keys. */
export interface SetupWizardHandles {
  wizard: Wizard;
  runner: WizardRunner;
}

function inputStep(args: {
  title: string;
  field: keyof SetupConfig;
  prompt: string;
  placeholder: string;
  initial: string;
  runner: WizardRunner;
}): WizardStep {
  return {
    title: args.title,
    render: (state) => {
      const stored = String(state[args.field] ?? "");
      // The step keeps a reference to this widget, so it must be a REAL
      // renderable (WizardRunner.realizeNode) — a bare factory proxy reads
      // values from an uninitialized template instance. Enter stores the
      // field and advances (the footer's "[Enter next]"); OpenTUI 0.1.107
      // Input submits via an "enter" event carrying the current text
      // (`onSubmit` is Textarea-only and never fires on Input).
      const input = args.runner.realizeNode(
        Input({
          placeholder: args.placeholder,
        }),
      ) as unknown as Renderable & {
        value: string;
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      input.value = stored.length > 0 ? stored : args.initial;
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
      if (v.length > 0) return null;
      return `${args.field} is required`;
    },
  };
}

export function createSetupWizard(opts: {
  renderer: CliRenderer;
  writeConfig: (config: SetupConfig) => void | Promise<void>;
  onDone: (outcome: SetupOutcome) => void;
  defaultServerUrl?: string;
  defaultHostname?: string;
}): SetupWizardHandles {
  const runner = new WizardRunner({
    id: "first-run-setup",
    title: "First-run setup",
    steps: [],
    renderer: opts.renderer,
  });

  const steps: WizardStep[] = [
    inputStep({
      title: "Server URL",
      field: "serverUrl",
      prompt: "Full URL of the LamaSync server (REST + WebSocket).",
      placeholder: DEFAULT_URL,
      initial: opts.defaultServerUrl ?? DEFAULT_URL,
      runner,
    }),
    inputStep({
      title: "API key",
      field: "apiKey",
      prompt:
        "The pre-shared API key from the server. Stored plain in client.toml — the same key works on every client.",
      placeholder: "long-random-string",
      initial: "",
      runner,
    }),
    inputStep({
      title: "Device name",
      field: "hostname",
      prompt: "This machine's identifier on the server (stored as client.toml hostname).",
      placeholder: opts.defaultHostname ?? osHostname(),
      initial: opts.defaultHostname ?? osHostname(),
      runner,
    }),
    {
      title: "Confirm",
      render: (state) => {
        const lines = [
          `Server URL:  ${String(state["serverUrl"] ?? "(missing)")}`,
          `Hostname:    ${String(state["hostname"] ?? "(missing)")}`,
          "API key:     (set — hidden)",
          "",
          "Write ~/.config/lamasync/client.toml?  Enter to confirm, Esc to go back, q to cancel.",
        ];
        const children: Renderable[] = lines.map((line) =>
          Text({ content: line }) as unknown as Renderable,
        );
        return Box({ flexDirection: "column", gap: 1 }, ...children) as unknown as Renderable;
      },
      // No focusable widget on this step — Enter applies (runner.next() on
      // the last step fires onFinish, which writes the config).
      onKey: (name, char) => {
        if (name === "return" || name === "enter" || char === "\r") {
          runner.next();
          return true;
        }
        return false;
      },
    },
  ];

  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    runner,
    wizard: {
      id: runner.id,
      title: runner.title,
      container: (runner as unknown as { modal: Renderable }).modal,
      handleKey: (e) => runner.handleKey(e),
      onCancel: () => opts.onDone("skipped"),
      onFinish: async (state) => {
        await opts.writeConfig({
          serverUrl: String(state["serverUrl"] ?? ""),
          apiKey: String(state["apiKey"] ?? ""),
          hostname: String(state["hostname"] ?? ""),
        });
        opts.onDone("saved");
      },
    },
  };
}

/**
 * Boot-time harness: mount the setup wizard on a bare overlay, start the
 * renderer, and drive it with a keypress handler until the flow resolves
 * ("saved" after the config file is written, "skipped" on cancel). The
 * overlay and key handler are removed before the caller builds the Shell.
 */
export async function runSetupFlow(opts: {
  renderer: CliRenderer;
  writeConfig: (config: SetupConfig) => void | Promise<void>;
  defaultHostname?: string;
}): Promise<SetupOutcome> {
  const { renderer } = opts;
  return new Promise<SetupOutcome>((resolve) => {
    const overlay = Box({
      flexDirection: "column",
      flexGrow: 1,
    }) as unknown as Renderable;
    renderer.root.add(overlay);

    const { wizard, runner } = createSetupWizard({
      renderer: opts.renderer,
      writeConfig: opts.writeConfig,
      defaultHostname: opts.defaultHostname,
      onDone: (outcome) => {
        renderer.root.remove(overlay.id);
        renderer.keyInput.off("keypress", handler);
        resolve(outcome);
      },
    });

    openWizard(wizard);
    runner.setOverlayHost(overlay);
    renderer.start();

    const handler = (e: KeyEvent) => {
      // Consumed keys (ESC/q cancel, confirm-step Enter) must not also reach
      // a focused widget behind the wizard.
      if (wizard.handleKey?.(e) === true) e.preventDefault();
    };
    renderer.keyInput.on("keypress", handler);
  });
}
