import { Box, Text } from "@opentui/core";
import type { CliRenderer, KeyEvent, Renderable, VNode } from "@opentui/core";

import { realize } from "./widgets.ts";

/**
 * A single step in a wizard flow.
 *
 * - `title` is required (the step's header label).
 * - `render` is optional in the type but every interactive step supplies one;
 *   keeping it optional lets the runner be exercised in pure state-machine
 *   tests without instantiating any OpenTUI renderables.
 * - `validate` runs against the accumulated state before advancing. A
 *   non-null return string is shown in the wizard's error slot and blocks
 *   the step transition.
 * - `onKey` lets a step intercept keys before the runner falls back to its
 *   built-in ESC/q handling. Returning `true` tells the runner the event was
 *   consumed.
 */
export interface WizardStep {
  readonly title: string;
  readonly render?: (state: Record<string, unknown>) => Renderable;
  readonly validate?: (state: Record<string, unknown>) => string | null;
  readonly onKey?: (
    keyName: string,
    char: string,
    state: Record<string, unknown>,
  ) => boolean;
}

/**
 * The wizard description handed to the Shell. `container` is the modal Box
 * the runner owns; the Shell mounts it once `openWizard(wizard)` is called.
 *
 * `onFinish` is the async side-effect applied at the end of the flow (e.g.
 * calling `api.createFolder` + `assignFolder`). The flow factory is
 * responsible for surfacing success / failure via the ViewContext's status
 * callback.
 */
export interface Wizard {
  readonly id: string;
  readonly title: string;
  readonly container: Renderable;
  /**
   * Optional key router the Shell calls when a wizard is active. The runner
   * exposes its own `handleKey`; flows attach it so ESC cancels, q cancels,
   * and the focused widget (Select / Input) consumes Enter.
   */
  readonly handleKey?: (e: KeyEvent) => boolean;
  readonly onCancel?: () => void;
  readonly onFinish?: (state: Record<string, unknown>) => void | Promise<void>;
}

/**
 * Process-wide registry of mounted wizards. The Shell consults this on each
 * keypress to route `escape` to the active wizard's cancel handler before the
 * global dispatcher falls through.
 *
 * One wizard at a time is the supported mode: opening a second wizard while
 * one is active replaces it (the prior modal is detached and its `onCancel`
 * is invoked so listeners can clean up).
 */
export const wizardRegistry: Map<string, Wizard> = new Map();

/** Mount a wizard so the Shell can route input to it. */
export function openWizard(wizard: Wizard): void {
  if (wizardRegistry.size > 0) {
    for (const existing of [...wizardRegistry.values()]) {
      existing.onCancel?.();
      detachContainer(existing.container);
    }
    wizardRegistry.clear();
  }
  wizardRegistry.set(wizard.id, wizard);
}

/** Remove the wizard with the given id from the registry. */
export function closeWizard(id: string): boolean {
  const existing = wizardRegistry.get(id);
  if (!existing) return false;
  detachContainer(existing.container);
  return wizardRegistry.delete(id);
}

/** Close whichever wizard is currently mounted, regardless of id. */
export function closeActiveWizard(): boolean {
  const last = activeWizard();
  if (!last) return false;
  return closeWizard(last.id);
}

/** Return the most recently mounted wizard, or `null` when none is active. */
export function activeWizard(): Wizard | null {
  if (wizardRegistry.size === 0) return null;
  const last = [...wizardRegistry.values()].at(-1);
  return last ?? null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Owns the state-machine side of a wizard: the step stack, the transient
 * state record, the error slot text, and the modal container.
 *
 * When constructed with a `renderer` (the production path — flows forward
 * `ctx.renderer`), the modal, its text slots, and the body host are
 * instantiated into real renderables so post-mount mutations (step body
 * swaps, error text updates) render live (LAMA-181). Without a renderer
 * (pure state-machine tests) the nodes stay VNode proxies and the runner
 * only exercises the state machine; the modal is parked in a hidden scratch
 * Box until the Shell mounts it via `setOverlayHost`.
 */
export class WizardRunner {
  readonly steps: ReadonlyArray<WizardStep>;
  readonly title: string;
  readonly id: string;

  private readonly state: Record<string, unknown> = {};
  private readonly scratchHost: Renderable;
  private readonly modal: Renderable;
  private readonly headerText: Renderable;
  private readonly bodyHost: Renderable;
  private readonly errorText: Renderable;
  private readonly footerText: Renderable;

  private idx = 0;
  private overlayHost: Renderable | null = null;
  private finished = false;
  private readonly renderer: CliRenderer | null;

  private currentBodyChild: Renderable | null = null;
  private focusedStepWidget: { blur?: () => void } | null = null;

  private currentError: string | null = null;

  constructor(opts: {
    id: string;
    title: string;
    steps: ReadonlyArray<WizardStep>;
    renderer?: CliRenderer | null;
  }) {
    this.id = opts.id;
    this.title = opts.title;
    this.steps = opts.steps;
    this.renderer = opts.renderer ?? null;

    const renderer = opts.renderer ?? null;
    this.scratchHost = realize<Renderable>(
      renderer,
      Box({ flexDirection: "column", visible: false }),
    );

    this.headerText = realize<Renderable>(
      renderer,
      Text({ content: this.headerLabel() }),
    );
    this.errorText = realize<Renderable>(renderer, Text({ content: "" }));
    this.footerText = realize<Renderable>(
      renderer,
      Text({
        content: "[Esc back]   [Enter next]   [q cancel]",
      }),
    );
    this.bodyHost = realize<Renderable>(
      renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    );

    this.modal = realize<Renderable>(
      renderer,
      Box(
        {
          flexDirection: "column",
          padding: 1,
          border: true,
          position: "absolute",
          width: 60,
          height: 16,
          backgroundColor: "black",
        },
        this.headerText,
        this.bodyHost,
        this.errorText,
        this.footerText,
      ),
    );
    this.scratchHost.add(this.modal);
    // Defer first render until setOverlayHost is called. The step body child
    // is tracked locally (`currentBodyChild`), which keeps remove/add safe
    // both on real renderables and on uninstantiated proxies in tests.
  }

  /** Read-only snapshot of the accumulated state. */

  currentErrorMessage(): string | null {
    return this.currentError;
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  /** Current step index (0-based). */
  stepIdx(): number {
    return this.idx;
  }

  /** True once `next()` has invoked `onFinish` and the flow has resolved. */
  isFinished(): boolean {
    return this.finished;
  }

  /**
   * Write a single field on the state record. Flow code uses this from inside
   * step `render` callbacks (`Input.onSubmit`, `Select.onItemSelected`).
   */
  setField(key: string, value: unknown): void {
    this.state[key] = value;
  }

  /**
   * Replace the step list and clamp the current index. Flows use this when a
   * choice on an earlier step inserts or removes a later step (e.g. the
   * schedule-preset step adds an extra Cron step when "custom" is picked).
   */
  setSteps(steps: ReadonlyArray<WizardStep>, atIndex?: number): void {
    const insertAt = atIndex ?? this.idx + 1;
    const before = (this.steps as ReadonlyArray<WizardStep>).slice(0, insertAt);
    const after = (this.steps as ReadonlyArray<WizardStep>).slice(insertAt);
    (this as unknown as { steps: ReadonlyArray<WizardStep> }).steps = [
      ...before,
      ...steps,
      ...after,
    ];
    this.renderCurrentStep();
  }

  /**
   * Instantiate a step-body widget VNode into a real renderable on the
   * runner's renderer (LAMA-181). Step render functions MUST use this for
   * widgets they keep a reference to (Input / Select): a bare factory proxy
   * attaches listeners to — and reads values from — an uninitialized
   * template instance, not the mounted renderable (verified OpenTUI
   * 0.1.107: property reads on the proxy throw once mounted).
   */
  realizeNode(vnode: VNode): Renderable {
    return realize<Renderable>(this.renderer, vnode);
  }

  /**
   * Mount the modal into the supplied overlay host. Until this is called the
   * modal lives in a hidden scratch Box, so the runner can be constructed
   * and exercised in pure-state tests without a renderer.
   */
  setOverlayHost(host: Renderable): void {
    if (this.overlayHost === host) return;
    if (this.overlayHost) {
      this.overlayHost.remove(this.modal.id);
    }
    this.overlayHost = host;
    this.overlayHost.add(this.modal);
    // First mount: the modal is now attached to the live tree; render the
    // initial step body.
    if (this.currentBodyChild === null && this.steps.length > 0) {
      this.renderCurrentStep();
    }
  }

  /**
   * Attempt to advance to the next step. Runs the current step's validator
   * first; a non-null return is surfaced in the error slot and the index is
   * held. On the last step `onFinish` fires: a synchronous return closes the
   * wizard immediately, a returned promise that resolves also closes it,
   * and a rejection is rendered in the error slot (the wizard stays open).
   *
   * Returns the validation error string, or `null` when the call either
   * advanced or triggered the finish path.
   */
  next(): string | null {
    if (this.finished) return null;
    const step = this.steps[this.idx];
    if (!step) return null;

    if (step.validate) {
      const err = step.validate(this.state);
      if (err !== null) {
        this.setError(err);
        return err;
      }
    }
    this.setError(null);

    if (this.idx < this.steps.length - 1) {
      this.idx++;
      this.renderCurrentStep();
      return null;
    }

    const wizard = activeWizard();
    const finish = wizard?.onFinish;
    if (!finish) {
      this.finished = true;
      closeActiveWizard();
      return null;
    }
    let outcome: void | Promise<void>;
    try {
      outcome = finish(this.state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setError(msg);
      return msg;
    }
    if (outcome && typeof (outcome as Promise<void>).then === "function") {
      this.finished = true;
      (outcome as Promise<void>)
        .then(() => {
          closeActiveWizard();
        })
        .catch((err: unknown) => {
          this.finished = false;
          const msg = err instanceof Error ? err.message : String(err);
          this.setError(msg);
        });
    } else {
      this.finished = true;
      closeActiveWizard();
    }
    return null;
  }

  /**
   * Step back one position. No-op when already on the first step.
   */
  back(): void {
    if (this.idx === 0) return;
    this.idx--;
    this.setError(null);
    this.renderCurrentStep();
  }

  /**
   * Cancel the wizard: detach the modal, clear the registry, fire `onCancel`.
   */
  cancel(): void {
    const wizard = activeWizard();
    if (wizard && wizard.id === this.id) {
      detachContainer(wizard.container);
      wizardRegistry.delete(wizard.id);
    }
    wizard?.onCancel?.();
    this.detachModal();
  }

  /**
   * Route a key event through the active step's `onKey`, falling back to the
   * runner's built-in handling for ESC (`back` / `cancel` on the first step)
   * and `q` (`cancel`). The Shell calls this method and uses the boolean
   * return to decide whether to drop the event.
   *
   * The runner never handles `Enter` — that belongs to the focused widget
   * (Select / Input) inside the step. And when a text widget inside the step
   * owns focus, every non-ESC key is left to it: without that guard, typing
   * "q" into an API-key field would cancel the wizard.
   */
  handleKey(e: KeyEvent): boolean {
    const step = this.steps[this.idx];
    const name = (e.name ?? "").toLowerCase();
    const raw = typeof e.raw === "string" ? e.raw : "";
    const sequence = typeof e.sequence === "string" ? e.sequence : "";
    const char =
      (raw.length === 1 ? raw : sequence.length === 1 ? sequence : "").toLowerCase();

    if (step?.onKey?.(name, char, this.state)) return true;

    if (name !== "escape" && this.hasFocusedTextInput()) return false;

    if (name === "escape") {
      if (this.idx === 0) {
        this.cancel();
      } else {
        this.back();
      }
      return true;
    }
    if (char === "q") {
      this.cancel();
      return true;
    }
    return false;
  }

  /**
   * True when the renderer's focused renderable is a text-editing widget
   * (Input / Textarea). No renderer (pure state-machine tests) → false.
   */
  private hasFocusedTextInput(): boolean {
    if (!this.renderer) return false;
    const focused = (
      this.renderer as { currentFocusedRenderable?: unknown }
    ).currentFocusedRenderable;
    if (focused === null || focused === undefined) return false;
    const type = (focused as { constructor?: { name?: string } }).constructor
      ?.name;
    return type === "InputRenderable" || type === "TextareaRenderable";
  }

  // -- internal ------------------------------------------------------------

  private headerLabel(): string {
    const step = this.steps[this.idx];
    const suffix = step ? `: ${step.title}` : "";
    return `${this.title} — step ${this.idx + 1}/${this.steps.length}${suffix}`;
  }

  private setError(message: string | null): void {
    this.currentError = message && message.length > 0 ? `[!] ${message}` : null;
    try {
      (this.errorText as unknown as { content: string }).content =
        this.currentError ?? "";
    } catch {
      // Proxies may reject the setter before the modal is instantiated; the
      // currentError field is the source of truth for the runner.
    }
  }

  private renderCurrentStep(): void {
    const step = this.steps[this.idx];
    if (!step) return;
    (this.headerText as unknown as { content: string }).content = this.headerLabel();

    // Replace the body child using our own tracker rather than asking the
    // body host. The tracker holds the REAL mounted child (step render
    // returns are realized below): removing by a VNode proxy's id silently
    // no-ops and the old step body stays mounted, still eating keys.
    if (this.currentBodyChild) {
      // Blur before removal: OpenTUI 0.1.107 `onRemove` is a no-op, so a
      // removed-but-focused Input would keep its keypress subscription and
      // consume keys for the next step.
      this.focusedStepWidget?.blur?.();
      this.focusedStepWidget = null;
      this.bodyHost.remove(this.currentBodyChild.id);
      this.currentBodyChild = null;
    }
    const rendered = step.render?.(this.state);
    if (rendered) {
      const mounted = realize<Renderable>(
        this.renderer,
        rendered as unknown as VNode,
      );
      this.bodyHost.add(mounted);
      this.currentBodyChild = mounted;
      // Nothing in OpenTUI auto-focuses newly-added renderables — without
      // this the step's Input/Select never receives keystrokes at all.
      this.focusFirstStepWidget();
    }
    this.setError(null);
  }

  /**
   * Focus the first focusable widget inside the freshly-rendered step body
   * so keyboard input lands in it without a mouse click. Walks the body
   * host's REAL children (`getChildren()`), not the step's render return —
   * that may be an uninstantiated VNode proxy whose child list is empty.
   * No-op without a renderer (pure state-machine tests) or on text-only
   * steps (Confirm), whose Enter is handled by the step's own `onKey`.
   */
  private focusFirstStepWidget(): void {
    if (!this.renderer) return;
    const host = this.bodyHost as unknown as {
      getChildren?: () => Renderable[];
    };
    const top = typeof host.getChildren === "function" ? host.getChildren() : [];
    const walk = (node: Renderable): boolean => {
      const n = node as unknown as {
        focusable?: boolean;
        focus?: () => void;
        blur?: () => void;
        getChildren?: () => Renderable[];
      };
      if (n.focusable && typeof n.focus === "function") {
        n.focus();
        this.focusedStepWidget = n;
        return true;
      }
      const children = typeof n.getChildren === "function" ? n.getChildren() : [];
      for (const child of children) {
        if (walk(child)) return true;
      }
      return false;
    };
    for (const child of top) {
      if (walk(child)) return;
    }
  }

  private detachModal(): void {
    // Same reason as in renderCurrentStep: removal does not blur, and a
    // focused widget inside the modal would stay subscribed after close.
    this.focusedStepWidget?.blur?.();
    this.focusedStepWidget = null;
    if (this.overlayHost) {
      this.overlayHost.remove(this.modal.id);
    } else {
      this.scratchHost.remove(this.modal.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detach a renderable from its parent. The parent's `remove(id)` may throw
 * when the renderable has already been detached, so swallow the error.
 */
function detachContainer(container: Renderable): void {
  const parent = (container as unknown as { parent?: Renderable | null }).parent;
  if (parent && typeof parent.remove === "function") {
    try {
      parent.remove(container.id);
    } catch {
      // The renderable may already be detached; ignore.
    }
  }
}