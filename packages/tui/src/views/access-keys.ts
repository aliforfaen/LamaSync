// Access keys view (LAMA-234 TUI completion): a drill-in screen reachable
// from the More menu (hidden from the tab bar, `homeTab: "more"`).
//
// Credential-aware surface:
//   - master / managed admin → masked managed-key table + create/pair/
//     reveal/revoke/refresh actions.
//   - host-bound device        → identity-only screen; the view never calls
//     `/api-keys` and never offers a management action.
//
// Security contract (see docs/handoff-234-tui-access-keys-plan.md):
//   - The raw secret from create/reveal lives only in the open wizard's
//     private closure field, is cleared on every exit path (close, cancel,
//     hide, destroy, failed refresh), and never enters status text, rows,
//     logs, config writes, or thrown error messages.
//   - No action is sent before its explicit confirmation step.
//   - The pairing poller is stopped on every close / hide / cancel /
//     expiry / destroy path.
//
// Implements the foundation `View` contract (LAMA-173): the outer
// container is built once in the constructor; refreshes swap only the body
// Box's children (`realize()` for every post-mount-mutated node,
// `swapChildren()` for refresh). Enter is owned by focused widgets / the
// wizard runner — this view never handles it and neither does the Shell.

import { Box, Input, Select, Text } from "@opentui/core";
import type {
  BoxRenderable,
  KeyEvent,
  ProxiedVNode,
  Renderable,
  SelectRenderable,
  VNode,
} from "@opentui/core";

import type {
  ApiKeySummary,
  AuthMeResponse,
  PairingSessionStatusResponse,
} from "@lamasync/core";

import type { Hotkey } from "../app/keymap.ts";
import { PALETTE_BG, SELECTION } from "../app/palette.ts";
import type { View, ViewContext, ViewId } from "../app/view-manager.ts";
import { closeWizard, Wizard, WizardRunner, WizardStep } from "../app/wizard.ts";
import {
  hotkeyFooter,
  pageShell,
  realize,
  statusBox,
  swapChildren,
} from "../app/widgets.ts";
import { friendlyError } from "../friendly-error.ts";
import {
  AccessKeyRowDisplay,
  canManageAccessKeys,
  DEVICE_EXPLANATION,
  formatCountdown,
  principalLabel,
  revokeConfirmLine,
  SECRET_SCROLLBACK_WARNING,
  secondsUntil,
  toAccessKeyRows,
} from "../access-keys.ts";

// ---------------------------------------------------------------------------
// Shared wizard bits
// ---------------------------------------------------------------------------

function isEnter(name: string, char: string): boolean {
  return name === "return" || name === "enter" || char === "\r";
}

/** Text-only confirm step: Enter fires the action, Esc/q route to the
 *  runner's built-in cancel/back. The body is a function so the copy can
 *  reflect state captured at render time. */
function confirmStep(
  runner: WizardRunner,
  body: (state: Record<string, unknown>) => string[],
  onConfirm: () => void,
): WizardStep {
  return {
    title: "Confirm",
    render: (state) =>
      Box(
        { flexDirection: "column", gap: 1 },
        ...body(state).map((line) => Text({ content: line })),
      ) as unknown as Renderable,
    onKey: (name, char) => {
      if (isEnter(name, char)) {
        onConfirm();
        return true;
      }
      return false;
    },
  };
}

/** Transient secret display step. The secret is read from the supplied
 *  getter (the wizard's private closure field) so the panel owns it alone;
 *  Enter acknowledges + closes, Esc cancels (clears via onCancel). */
function secretStep(
  runner: WizardRunner,
  getSecret: () => string | null,
): WizardStep {
  return {
    title: "Save it now",
    render: () =>
      Box(
        { flexDirection: "column", gap: 1 },
        Text({
          content:
            "SAVE THIS NOW — this secret is shown once and never appears again.",
        }),
        Text({ content: "" }),
        Text({ content: getSecret() ?? "(secret cleared)" }),
        Text({ content: "" }),
        Text({
          content:
            "Terminals may retain scrollback or recordings. Enter when saved, q/Esc to cancel.",
        }),
      ) as unknown as Renderable,
    onKey: (name, char) => {
      if (isEnter(name, char)) {
        runner.next();
        return true;
      }
      if (name === "escape") {
        runner.cancel();
        return true;
      }
      return false;
    },
  };
}

// ---------------------------------------------------------------------------
// Create-key wizard
// ---------------------------------------------------------------------------

export interface CreateKeyWizardHandle extends Wizard {
  /** Null the private secret reference. Safe to call at any time. */
  clearSecret: () => void;
  /** Test seam: current in-memory secret (null once cleared). */
  secretSnapshot: () => string | null;
  /** Mirror of the label Input's enter handler (test seam). Returns true
   *  when validation passed and the flow advanced off the label step. */
  setLabel: (label: string) => boolean;
  handleKey: (e: KeyEvent) => boolean;
}

/**
 * Create-key flow: label → confirm → transient secret panel. The secret is
 * held in a closure owned by the wizard (`currentSecret`) and cleared by
 * `clearSecret()` / onCancel / onFinish. `afterCreate` runs right after the
 * POST succeeds and BEFORE the secret is shown; throwing there (e.g. a
 * failed list refresh) aborts the panel and keeps the view secret-free.
 */
export function createCreateKeyWizard(deps: {
  ctx: ViewContext;
  afterCreate?: (key: ApiKeySummary) => void | Promise<void>;
  /** Fired whenever the wizard closes (finish OR cancel) so the view can
   *  drop its live panel handle. */
  onClosed?: () => void;
}): CreateKeyWizardHandle {
  const { ctx } = deps;
  const runner = new WizardRunner({
    id: "access-keys-create",
    title: "Create admin key",
    steps: [],
    renderer: ctx.renderer,
  });

  let currentSecret: string | null = null;
  let busy = false;
  let cancelled = false;

  const runCreate = async (): Promise<void> => {
    if (busy || cancelled) return;
    busy = true;
    const name = String(runner.getState()["label"] ?? "").trim();
    try {
      const res = await ctx.api.createApiKey({ name });
      if (cancelled) return;
      await deps.afterCreate?.(res.key);
      if (cancelled) return;
      currentSecret = res.secret;
      runner.next();
    } catch (err) {
      if (cancelled) return;
      ctx.setStatus(friendlyError(err), "error");
    } finally {
      busy = false;
    }
  };

  const labelStep: WizardStep = {
    title: "Label",
    render: () => {
      const input = runner.realizeNode(
        Input({ placeholder: "Admin laptop" }),
      ) as unknown as Renderable & {
        value: string;
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      input.value = String(runner.getState()["label"] ?? "");
      input.on("enter", (value: unknown) => {
        runner.setField("label", String(value ?? "").trim());
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({
          content: "A human label for this admin key (e.g. 'Admin laptop').",
        }),
        input,
      ) as unknown as Renderable;
    },
    validate: (state) => {
      const name = String(state["label"] ?? "").trim();
      if (name.length === 0) return "label is required";
      if (name.length > 64) return "label must be 64 characters or fewer";
      return null;
    },
  };

  const steps: WizardStep[] = [
    labelStep,
    confirmStep(
      runner,
      (state) => [
        `Create admin key "${String(state["label"] ?? "-").trim()}"?`,
        "",
        "The raw secret is shown exactly once after this confirmation.",
      ],
      () => void runCreate(),
    ),
    secretStep(runner, () => currentSecret),
  ];
  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    mount: (host) => runner.setOverlayHost(host),
    handleKey: (e) => runner.handleKey(e),
    onCancel: () => {
      currentSecret = null;
      ctx.setStatus("Create cancelled", "info");
      deps.onClosed?.();
    },
    onFinish: () => {
      currentSecret = null;
      deps.onClosed?.();
    },
    clearSecret: () => {
      currentSecret = null;
    },
    secretSnapshot: () => currentSecret,
    setLabel: (label: string): boolean => {
      runner.setField("label", String(label ?? "").trim());
      return runner.next() === null;
    },
  };
}

// ---------------------------------------------------------------------------
// Reveal wizard
// ---------------------------------------------------------------------------

export interface RevealKeyWizardHandle extends Wizard {
  clearSecret: () => void;
  secretSnapshot: () => string | null;
  handleKey: (e: KeyEvent) => boolean;
}

export function createRevealKeyWizard(deps: {
  ctx: ViewContext;
  key: ApiKeySummary;
  onClosed?: () => void;
}): RevealKeyWizardHandle {
  const { ctx, key } = deps;
  const runner = new WizardRunner({
    id: "access-keys-reveal",
    title: "Reveal key",
    steps: [],
    renderer: ctx.renderer,
  });

  let currentSecret: string | null = null;
  let busy = false;
  let cancelled = false;

  const runReveal = async (): Promise<void> => {
    if (busy || cancelled) return;
    busy = true;
    try {
      const res = await ctx.api.revealApiKey(key.id);
      if (cancelled) return;
      currentSecret = res.secret;
      runner.next();
    } catch (err) {
      if (cancelled) return;
      ctx.setStatus(friendlyError(err), "error");
    } finally {
      busy = false;
    }
  };

  const steps: WizardStep[] = [
    confirmStep(
      runner,
      () => [SECRET_SCROLLBACK_WARNING, "", `Reveal "${key.name}" (${key.kind})?`],
      () => void runReveal(),
    ),
    secretStep(runner, () => currentSecret),
  ];
  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    mount: (host) => runner.setOverlayHost(host),
    handleKey: (e) => runner.handleKey(e),
    onCancel: () => {
      currentSecret = null;
      ctx.setStatus("Reveal cancelled", "info");
      deps.onClosed?.();
    },
    onFinish: () => {
      currentSecret = null;
      deps.onClosed?.();
    },
    clearSecret: () => {
      currentSecret = null;
    },
    secretSnapshot: () => currentSecret,
  };
}

// ---------------------------------------------------------------------------
// Revoke wizard
// ---------------------------------------------------------------------------

export interface RevokeKeyWizardHandle extends Wizard {
  /** Mirror of the reason Input's enter handler (test seam). */
  setReason: (reason: string) => void;
  handleKey: (e: KeyEvent) => boolean;
}

export function createRevokeKeyWizard(deps: {
  ctx: ViewContext;
  key: ApiKeySummary;
  afterRevoke?: () => void | Promise<void>;
}): RevokeKeyWizardHandle {
  const { ctx, key } = deps;
  const runner = new WizardRunner({
    id: "access-keys-revoke",
    title: "Revoke key",
    steps: [],
    renderer: ctx.renderer,
  });

  const reasonStep: WizardStep = {
    title: "Reason (optional)",
    render: () => {
      const input = runner.realizeNode(
        Input({ placeholder: "optional reason" }),
      ) as unknown as Renderable & {
        value: string;
        on: (event: string, handler: (...params: unknown[]) => void) => void;
      };
      input.value = String(runner.getState()["reason"] ?? "");
      input.on("enter", (value: unknown) => {
        runner.setField("reason", String(value ?? "").trim());
        runner.next();
      });
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({
          content:
            "Optional reason for the audit trail (e.g. 'replaced laptop'). Press Enter to skip.",
        }),
        input,
      ) as unknown as Renderable;
    },
    validate: () => null,
  };

  const steps: WizardStep[] = [
    reasonStep,
    confirmStep(
      runner,
      () => [
        revokeConfirmLine(key),
        "",
        key.kind === "device"
          ? "The device will receive 401 until an administrator re-pairs it."
          : "The key will stop working immediately.",
      ],
      () => runner.next(),
    ),
  ];
  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    mount: (host) => runner.setOverlayHost(host),
    handleKey: (e) => runner.handleKey(e),
    onCancel: () => {
      ctx.setStatus("Revoke cancelled", "info");
    },
    onFinish: async () => {
      const reason = String(runner.getState()["reason"] ?? "").trim();
      try {
        await ctx.api.revokeApiKey(key.id, reason === "" ? {} : { reason });
        ctx.setStatus(`revoked "${key.name}"`, "success");
        await deps.afterRevoke?.();
      } catch (err) {
        ctx.setStatus(`revoke failed: ${friendlyError(err)}`, "error");
      }
    },
    setReason: (reason: string): void => {
      runner.setField("reason", String(reason ?? "").trim());
      runner.next();
    },
  };
}

// ---------------------------------------------------------------------------
// Pair-device wizard (10-minute single-use session + live countdown)
// ---------------------------------------------------------------------------

export interface PairDeviceWizardHandle extends Wizard {
  stopPolling: () => void;
  /** Test seam: the code currently displayed (never a managed secret). */
  currentCode: () => string | null;
  handleKey: (e: KeyEvent) => boolean;
}

export function createPairDeviceWizard(deps: {
  ctx: ViewContext;
  onClosed?: () => void;
}): PairDeviceWizardHandle {
  const { ctx } = deps;
  const runner = new WizardRunner({
    id: "access-keys-pair",
    title: "Pair device",
    steps: [],
    renderer: ctx.renderer,
  });

  const POLL_MS = 10_000;
  const TICK_MS = 1_000;

  let session: { code: string; expiresAt: string } | null = null;
  let polled: PairingSessionStatusResponse["status"] | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let destroyed = false;
  let busy = false;

  /** Clear a live session's timers without closing the wizard. This is used
   * before regenerating an expired code so the old session cannot keep
   * polling alongside the new one. */
  const clearTimers = (): void => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };

  const stopPolling = (): void => {
    destroyed = true;
    clearTimers();
  };

  /** Force the current step to re-render (live countdown). */
  const rerender = (): void => {
    if (destroyed) return;
    try {
      runner.setSteps([], runner.stepIdx());
    } catch {
      // Proxy-only runners (renderer-less tests) cannot re-render; the
      // state machine itself is unaffected.
    }
  };

  const pollOnce = async (): Promise<void> => {
    if (destroyed || !session) return;
    try {
      const status = await ctx.api.lookupPairingSession(session.code);
      if (destroyed || !session) return;
      polled = status.status;
      if (status.status === "pending" && status.expiresAt) {
        session = { ...session, expiresAt: status.expiresAt };
      }
      rerender();
    } catch (err) {
      if (destroyed) return;
      // Transient poll errors don't kill the code screen; surface once.
      ctx.setStatus(`pairing poll failed: ${friendlyError(err)}`, "error");
    }
  };

  const startSession = async (): Promise<void> => {
    if (busy || destroyed) return;
    busy = true;
    const advanceToCodeStep = runner.stepIdx() === 0;
    // An expired session can be regenerated from the same code screen. Stop
    // its poll/countdown pair before creating the replacement so we never
    // accumulate duplicate intervals for every regeneration.
    clearTimers();
    try {
      const res = await ctx.api.createPairingSession({ ttlSeconds: 600 });
      if (destroyed) return;
      session = {
        code: res.code,
        expiresAt: new Date(Date.now() + res.expiresInSeconds * 1000).toISOString(),
      };
      polled = null;
      if (advanceToCodeStep) {
        runner.next();
      } else {
        // Regeneration happens from the final code step. Advancing that step
        // would finish the wizard and erase the replacement code, so repaint
        // in place instead.
        rerender();
      }
      await pollOnce();
      pollTimer = setInterval(() => void pollOnce(), POLL_MS);
      tickTimer = setInterval(rerender, TICK_MS);
    } catch (err) {
      if (destroyed) return;
      ctx.setStatus(`pairing failed: ${friendlyError(err)}`, "error");
    } finally {
      busy = false;
    }
  };

  const startStep: WizardStep = {
    title: "Start",
    render: () =>
      Box(
        { flexDirection: "column", gap: 1 },
        Text({
          content:
            "Creates a 10-minute, single-use pairing session. The device runs:",
        }),
        Text({
          content: `  lamasync register --server ${ctx.api.baseUrl} --code <code>`,
        }),
        Text({ content: "" }),
        Text({ content: "Enter to create the session, q/Esc to cancel." }),
      ) as unknown as Renderable,
    onKey: (name, char) => {
      if (isEnter(name, char)) {
        void startSession();
        return true;
      }
      return false;
    },
  };

  const codeStep: WizardStep = {
    title: "Code",
    render: () => {
      if (!session) {
        return Box(
          { flexDirection: "column" },
          Text({ content: "(no session — press Esc to close)" }),
        ) as unknown as Renderable;
      }
      const remaining = secondsUntil(session.expiresAt, Date.now());
      const code = session.code;
      let stateLine: string;
      if (polled === "used") {
        stateLine = "Status: USED — this session has been claimed by a device.";
      } else if (polled === "expired" || remaining === 0) {
        stateLine = "Status: EXPIRED — press Enter for a fresh code.";
      } else {
        stateLine = `Status: pending · expires in ${formatCountdown(remaining)}`;
      }
      return Box(
        { flexDirection: "column", gap: 1 },
        Text({ content: `Code: ${code}` }),
        Text({ content: stateLine }),
        Text({ content: "" }),
        Text({
          content:
            `Next-device command:\n` +
            `  lamasync register --server ${ctx.api.baseUrl} --code ${code}`,
        }),
        Text({ content: "" }),
        Text({
          content:
            polled === "used"
              ? "Enter to close."
              : "Enter for a fresh code when expired; q/Esc to close.",
        }),
      ) as unknown as Renderable;
    },
    onKey: (name, char) => {
      if (isEnter(name, char)) {
        const expired =
          polled === "expired" ||
          secondsUntil(session?.expiresAt ?? "", Date.now()) === 0;
        if (expired) {
          void startSession();
        } else {
          runner.next();
        }
        return true;
      }
      // A plain Esc on the code screen cancels the whole pairing (and
      // stops the poller) — it must not just walk back to the start step.
      if (name === "escape") {
        runner.cancel();
        return true;
      }
      return false;
    },
  };

  const steps: WizardStep[] = [startStep, codeStep];
  (runner as unknown as { steps: ReadonlyArray<WizardStep> }).steps = steps;

  return {
    id: runner.id,
    title: runner.title,
    container: (runner as unknown as { modal: Renderable }).modal,
    mount: (host) => runner.setOverlayHost(host),
    handleKey: (e) => runner.handleKey(e),
    onCancel: () => {
      stopPolling();
      session = null;
      ctx.setStatus("Pairing cancelled", "info");
      deps.onClosed?.();
    },
    onFinish: () => {
      stopPolling();
      session = null;
      deps.onClosed?.();
    },
    stopPolling,
    currentCode: () => session?.code ?? null,
  };
}

// ---------------------------------------------------------------------------
// AccessKeysView
// ---------------------------------------------------------------------------

export class AccessKeysView implements View {
  static readonly id: ViewId = "access-keys";
  static readonly title = "Access keys";

  readonly id: ViewId = AccessKeysView.id;
  readonly title: string = AccessKeysView.title;

  private readonly bodyBox: BoxRenderable;
  private readonly statusBlock: BoxRenderable;
  private readonly footerBox: BoxRenderable;
  private currentSelect: ProxiedVNode<typeof SelectRenderable> | null = null;
  private currentHotkeys: Hotkey[] = [];

  // Principal + table state
  private me: AuthMeResponse | null = null;
  private keys: ApiKeySummary[] = [];
  private rows: AccessKeyRowDisplay[] = [];
  private selectedId: string | null = null;
  private phase: "loading" | "error" | "device" | "table" = "loading";
  private error: string | null = null;
  private loadId = 0;
  private ctx: ViewContext | null = null;

  // Live wizard handles owned by this view (secret lifecycle + poller).
  private secretPanel: { wizard: Wizard; clearSecret: () => void } | null = null;
  private pairWizard: { wizard: Wizard; stopPolling: () => void } | null = null;

  readonly container: Renderable;

  constructor(opts: { ctx: ViewContext }) {
    const renderer = opts.ctx.renderer;
    this.bodyBox = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column", flexGrow: 1 }),
    );
    this.statusBlock = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column" }),
    );
    this.footerBox = realize<BoxRenderable>(
      renderer,
      Box({ flexDirection: "column" }),
    );
    this.container = realize<Renderable>(
      renderer,
      pageShell(
        "Access keys",
        Box(
          { flexDirection: "column", flexGrow: 1 },
          this.bodyBox,
          this.statusBlock,
          this.footerBox,
        ),
      ),
    );
    // Boot-time hotkey snapshot (the Shell reads hotkeys() once at boot);
    // live contextual actions are dispatched by handleKey instead.
    this.currentHotkeys = [
      { key: "R", label: "refresh", run: () => void this.refresh() },
    ];
  }

  hotkeys(): ReadonlyArray<Hotkey> {
    return this.currentHotkeys;
  }

  /** Test seam: current phase. */
  phaseOf(): "loading" | "error" | "device" | "table" {
    return this.phase;
  }

  /** Test seam: in-memory secret of the live panel (null when none/cleared). */
  secretSnapshot(): string | null {
    const panel = this.secretPanel as
      | { wizard: Wizard & { secretSnapshot?: () => string | null } }
      | null;
    if (!panel || typeof panel.wizard.secretSnapshot !== "function") return null;
    return panel.wizard.secretSnapshot();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  onShow(ctx: ViewContext): void {
    this.ctx = ctx;
    this.loadId++;
    // A late response from a previous show must not repaint this one.
    this.renderBody();
    void this.refresh();
  }

  onHide(): void {
    this.loadId++;
    this.stopPairPolling();
    this.clearSecretPanel();
    this.ctx = null;
  }

  destroy(): void {
    this.loadId++;
    this.stopPairPolling();
    this.clearSecretPanel();
    this.ctx = null;
  }

  // -------------------------------------------------------------------------
  // Key handling — case-sensitive action keys only; Enter/Esc belong to
  // focused widgets, wizards, and the Shell's drill-in Esc handling.
  // -------------------------------------------------------------------------

  handleKey(e: KeyEvent): boolean {
    const raw = typeof e.raw === "string" ? e.raw : "";
    if (raw.length !== 1) return false;

    // Refresh is available from every phase except the device screen.
    if (raw === "R" && this.phase !== "device") {
      void this.refresh();
      return true;
    }
    if (this.phase !== "table") return false;

    if (raw === "c") {
      this.openCreateWizard();
      return true;
    }
    if (raw === "p") {
      this.openPairWizard();
      return true;
    }
    const row = this.selectedRow();
    if (!row) return false;
    if (raw === "r" && row.canReveal) {
      this.openRevealWizard(row.id);
      return true;
    }
    if (raw === "x" && row.canRevoke) {
      this.openRevokeWizard(row.id);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  private async refresh(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.loadId++;
    const myLoad = this.loadId;
    this.phase = "loading";
    this.error = null;
    this.renderBody();
    try {
      const me = await ctx.api.getAuthMe();
      if (myLoad !== this.loadId) return;
      this.me = me;
      if (!canManageAccessKeys(me)) {
        // Device principals must never hit /api-keys.
        this.phase = "device";
        this.keys = [];
        this.rows = [];
        this.renderBody();
        this.renderFooter();
        return;
      }
      const keys = await ctx.api.listApiKeys();
      if (myLoad !== this.loadId) return;
      this.applyKeys(keys);
      this.phase = "table";
      this.renderBody();
      this.renderFooter();
    } catch (err) {
      if (myLoad !== this.loadId) return;
      // An auth failure is NOT an empty key list — surface it distinctly
      // and clear any live secret so a stale panel can't survive a
      // failed refresh.
      this.phase = "error";
      this.error = friendlyError(err);
      ctx.setStatus(`access keys: ${this.error}`, "error");
      this.clearSecretPanel();
      this.renderBody();
      this.renderFooter();
    }
  }

  /** Replace table state from fresh summaries, preserving selection. */
  private applyKeys(keys: ApiKeySummary[]): void {
    this.keys = keys;
    this.rows = toAccessKeyRows(keys);
    const keep = Math.max(
      0,
      this.rows.findIndex((r) => r.id === this.selectedId),
    );
    this.selectedId = this.rows[keep]?.id ?? this.rows[0]?.id ?? null;
  }

  private keyById(id: string): ApiKeySummary | null {
    return this.keys.find((k) => k.id === id) ?? null;
  }

  private selectedRow(): AccessKeyRowDisplay | null {
    if (this.selectedId === null) return this.rows[0] ?? null;
    return this.rows.find((r) => r.id === this.selectedId) ?? this.rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderBody(): void {
    const me = this.me;
    let main: VNode;
    let heading: string;

    switch (this.phase) {
      case "loading":
        heading = "Loading access keys…";
        main = Box(
          { flexDirection: "column" },
          Text({ content: "Identifying the active credential…" }),
        );
        break;
      case "error":
        heading = "[!] Access keys unavailable";
        main = Box(
          { flexDirection: "column" },
          Text({ content: this.error ?? "unknown error" }),
          Text({ content: "Press R to retry." }),
        );
        break;
      case "device": {
        const hostId = me?.hostId ?? "(unknown)";
        const name = me?.name ?? null;
        heading = `Device credential — ${name ?? "unlabeled"}`;
        main = Box(
          { flexDirection: "column", gap: 1 },
          Text({ content: `Bound host id: ${hostId}` }),
          Text({ content: DEVICE_EXPLANATION }),
          Text({
            content:
              "This screen is read-only: device keys cannot manage fleet access.",
          }),
        );
        break;
      }
      case "table": {
        heading = "Managed keys";
        const principalLine =
          me && me.kind === "master"
            ? `${principalLabel(me)} — break-glass credential; it is never a row here and cannot be revealed or revoked.`
            : me
              ? `Active credential: ${principalLabel(me)}`
              : "Access keys";
        const opts = this.rows.map((row) => ({
          name: row.name,
          description: row.summary,
          value: row.id,
        }));
        if (opts.length === 0) {
          main = Box(
            { flexDirection: "column", gap: 1 },
            Text({ content: principalLine }),
            Text({
              content: "(no managed keys yet — press c to create an admin key)",
            }),
          );
        } else {
          const select = Select({
            options: opts,
            flexGrow: 1,
            showDescription: true,
            selectedIndex: Math.max(
              0,
              this.rows.findIndex((r) => r.id === this.selectedId),
            ),
            selectedBackgroundColor: PALETTE_BG.accent,
            selectedTextColor: SELECTION.fg,
          });
          select.on("selectionChanged", (_i: number, opt: { value: string }) => {
            const id = opt?.value;
            if (typeof id === "string") this.selectedId = id;
            this.renderFooter();
          });
          select.on("itemSelected", () => {
            // Enter on a row is intentionally inert — actions are hotkeys.
          });
          this.currentSelect = select;
          main = Box(
            { flexDirection: "column", flexGrow: 1, gap: 1 },
            Text({ content: principalLine }),
            select,
          );
        }
        break;
      }
    }

    const children: VNode[] = [
      Text({ content: heading }),
      Text({ content: "" }),
      main,
      Text({ content: "" }),
    ];
    swapChildren(this.bodyBox, children);

    const status = statusBox(this.error, "error");
    swapChildren(this.statusBlock, status === null ? [] : [status]);

    this.renderFooter();
  }

  /** Live contextual footer — advertises only actions valid now. */
  private renderFooter(): void {
    const items: Hotkey[] = [];
    if (this.phase === "table") {
      items.push({
        key: "c",
        label: "create",
        run: () => this.openCreateWizard(),
      });
      items.push({
        key: "p",
        label: "pair",
        run: () => this.openPairWizard(),
      });
      const row = this.selectedRow();
      if (row && row.canReveal) {
        items.push({
          key: "r",
          label: "reveal",
          run: () => this.openRevealWizard(row.id),
        });
      }
      if (row && row.canRevoke) {
        items.push({
          key: "x",
          label: "revoke",
          run: () => this.openRevokeWizard(row.id),
        });
      }
      items.push({ key: "R", label: "refresh", run: () => void this.refresh() });
    } else if (this.phase === "error") {
      items.push({ key: "R", label: "refresh", run: () => void this.refresh() });
    }
    this.currentHotkeys = items;
    swapChildren(
      this.footerBox,
      items.length === 0
        ? []
        : [hotkeyFooter(items.map((h) => ({ key: h.key, label: h.label })))],
    );
  }

  // -------------------------------------------------------------------------
  // Actions / wizards
  // -------------------------------------------------------------------------

  private openCreateWizard(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.secretPanel || this.pairWizard) return;
    const loadAtOpen = this.loadId;
    const wizard = createCreateKeyWizard({
      ctx,
      onClosed: () => {
        if (this.secretPanel?.wizard === wizard) this.secretPanel = null;
      },
      afterCreate: async (key) => {
        // Refresh the masked table before the secret is shown; a failed
        // refresh throws, which aborts the panel (view stays secret-free).
        const fresh = await ctx.api.listApiKeys();
        if (this.loadId !== loadAtOpen) return;
        this.applyKeys(fresh);
        if (this.phase === "table") this.renderBody();
      },
    });
    this.secretPanel = { wizard, clearSecret: wizard.clearSecret };
    ctx.openWizard(wizard);
  }

  private openRevealWizard(id: string): void {
    const ctx = this.ctx;
    const key = this.keyById(id);
    if (!ctx || !key) return;
    if (this.secretPanel || this.pairWizard) return;
    const wizard = createRevealKeyWizard({
      ctx,
      key,
      onClosed: () => {
        if (this.secretPanel?.wizard === wizard) this.secretPanel = null;
      },
    });
    this.secretPanel = { wizard, clearSecret: wizard.clearSecret };
    ctx.openWizard(wizard);
  }

  private openRevokeWizard(id: string): void {
    const ctx = this.ctx;
    const key = this.keyById(id);
    if (!ctx || !key) return;
    if (this.secretPanel || this.pairWizard) return;
    const wizard = createRevokeKeyWizard({
      ctx,
      key,
      afterRevoke: async () => {
        const fresh = await ctx.api.listApiKeys();
        this.applyKeys(fresh);
        if (this.phase === "table") this.renderBody();
      },
    });
    ctx.openWizard(wizard);
  }

  private openPairWizard(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.secretPanel || this.pairWizard) return;
    const wizard = createPairDeviceWizard({
      ctx,
      onClosed: () => {
        if (this.pairWizard?.wizard === wizard) this.pairWizard = null;
      },
    });
    this.pairWizard = { wizard, stopPolling: wizard.stopPolling };
    ctx.openWizard(wizard);
  }

  /** Close + clear a live secret panel without user-facing cancel copy. */
  private clearSecretPanel(): void {
    if (!this.secretPanel) return;
    this.secretPanel.clearSecret();
    closeWizard(this.secretPanel.wizard.id);
    this.secretPanel = null;
  }

  private stopPairPolling(): void {
    if (!this.pairWizard) return;
    this.pairWizard.stopPolling();
    closeWizard(this.pairWizard.wizard.id);
    this.pairWizard = null;
  }
}
