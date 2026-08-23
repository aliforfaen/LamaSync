/**
 * LAMA-270: cmd+k command palette for the authed web shell.
 *
 * Keyboard-driven overlay: ⌘/Ctrl+K toggles, ↑/↓ (and Tab/Shift+Tab) move
 * selection, Enter activates, Esc closes. Activating a command uses router
 * push (useNavigate) so HashRouter deep links are preserved — never
 * window.location.
 *
 * The command registry is derived from GROUPS in Nav.tsx (single source of
 * truth with the rail) plus a small set of page CTAs. Matching is the
 * dependency-free subsequence scorer in ../fuzzy.ts.
 *
 * Accessibility: combobox pattern — the input keeps focus, the option list
 * is exposed as a listbox, and aria-activedescendant announces the active
 * option. Focus is returned to the previously-focused element on close.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { GROUPS } from "./Nav.tsx";
import type { NavItem } from "./Nav.tsx";
import {
  IconConflict,
  IconFolder,
  IconHost,
  IconSearch,
  IconStorage,
} from "./icons.tsx";
import { fuzzyScore } from "../fuzzy.ts";

/** A single palette entry. Every entry navigates to a route. */
export interface PaletteCommand {
  id: string;
  label: string;
  /** Rail group ("Sync", "Storage & tools") or "Actions" for page CTAs. */
  group: string;
  icon: JSX.Element;
  to: string;
  /** Extra match text beyond the visible label. */
  keywords?: string;
}

/** Navigation commands for every rail item: the label itself + "Go to …". */
function railCommands(item: NavItem, groupLabel: string, goTo: boolean): PaletteCommand {
  return {
    id: `${goTo ? "go" : "nav"}:${item.to}`,
    label: goTo ? `Go to ${item.text}` : item.text,
    group: groupLabel,
    icon: item.icon,
    to: item.to,
    keywords: item.keywords,
  };
}

/**
 * Registry — order matters only for the empty-query default list and for
 * score ties (stable sort). CTAs first so an empty palette reads as a set of
 * next actions, then every rail page and its "Go to …" alias.
 */
const PALETTE_COMMANDS: PaletteCommand[] = [
  ...GROUPS.flatMap((group) =>
    group.items.flatMap((item) => [
      railCommands(item, group.label, false),
      railCommands(item, group.label, true),
    ]),
  ),
  // Page CTAs. Cross-component form-opening is deliberately out of scope:
  // each command navigates to the page that owns the flow (LAMA-270).
  {
    id: "cta:add-synced-folder",
    label: "Add synced folder",
    group: "Actions",
    icon: <IconFolder />,
    to: "/folders",
    keywords: "new folder create",
  },
  {
    id: "cta:pair-device",
    label: "Pair device",
    group: "Actions",
    icon: <IconHost />,
    to: "/hosts",
    keywords: "add device new host",
  },
  {
    id: "cta:resolve-conflicts",
    label: "Resolve conflicts",
    group: "Actions",
    icon: <IconConflict />,
    to: "/conflicts",
    keywords: "merge fix",
  },
  {
    id: "cta:add-storage-destination",
    label: "Add a storage destination",
    group: "Actions",
    icon: <IconStorage />,
    to: "/backends",
    keywords: "new storage destination backend",
  },
];

const MAX_RESULTS = 10;

function commandHaystack(command: PaletteCommand): string {
  return `${command.label} ${command.keywords ?? ""}`.trim();
}

function optionId(command: PaletteCommand): string {
  return `cmd-${command.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

interface ScoredCommand {
  command: PaletteCommand;
  score: number;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeOptionRef = useRef<HTMLLIElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  // Latest state for the (single, stable) global keydown listener — assigned
  // below so the listener always reads fresh values without re-binding.
  const stateRef = useRef({ open, results: [] as ScoredCommand[], activeIndex });

  const results = useMemo<ScoredCommand[]>(() => {
    const scored: ScoredCommand[] = [];
    for (const command of PALETTE_COMMANDS) {
      const score = fuzzyScore(query, commandHaystack(command));
      if (score !== null) scored.push({ command, score });
    }
    // Stable sort: equal scores keep registry order.
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [query]);
  stateRef.current = { open, results, activeIndex };

  function activate(command: PaletteCommand) {
    setOpen(false);
    navigate(command.to);
  }

  // Global shortcuts: ⌘/Ctrl+K toggles the palette anywhere in the shell;
  // while open, Esc/arrows/Enter/Tab drive the palette itself. Capture phase
  // + stopPropagation means the palette owns its handled keys before any
  // page-level handler (dialog Esc-close etc.) can react.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const state = stateRef.current;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        setOpen((o) => !o);
        return;
      }
      if (!state.open) return;

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          break;
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((i) =>
            state.results.length === 0 ? 0 : (i + 1) % state.results.length,
          );
          break;
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((i) =>
            state.results.length === 0
              ? 0
              : (i - 1 + state.results.length) % state.results.length,
          );
          break;
        case "Tab":
          // Keep keyboard focus inside the palette: Tab/Shift+Tab cycle the
          // selection exactly like the arrows (combobox keeps focus on input).
          event.preventDefault();
          event.stopPropagation();
          setActiveIndex((i) => {
            if (state.results.length === 0) return 0;
            return event.shiftKey
              ? (i - 1 + state.results.length) % state.results.length
              : (i + 1) % state.results.length;
          });
          break;
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          if (state.results.length > 0) {
            const command = state.results[state.activeIndex].command;
            setOpen(false);
            navigate(command.to);
          }
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [navigate]);

  // Focus the input on open (fresh query + selection); hand focus back to
  // the element that had it before (when it still exists — a navigation may
  // have unmounted it).
  useEffect(() => {
    if (open) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery("");
      setActiveIndex(0);
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    const prev = previousFocus.current;
    if (prev && document.contains(prev)) {
      const raf = requestAnimationFrame(() => prev.focus());
      previousFocus.current = null;
      return () => cancelAnimationFrame(raf);
    }
    previousFocus.current = null;
    return undefined;
  }, [open]);

  // Keep the highlighted option in view when selection or results change.
  useEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, results]);

  function onQueryChange(event: ChangeEvent<HTMLInputElement>) {
    setQuery(event.target.value);
    setActiveIndex(0);
  }

  if (!open) return null;

  const activeOptionId =
    results.length > 0 ? optionId(results[activeIndex].command) : undefined;

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <IconSearch className="icon palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            value={query}
            onChange={onQueryChange}
            placeholder="Search commands…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded={true}
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
          />
        </div>
        {results.length === 0 ? (
          <div className="palette-empty" role="status">
            No commands match “{query.trim()}”.
          </div>
        ) : (
          <ul className="palette-list" id="palette-listbox" role="listbox" aria-label="Commands">
            {results.map(({ command }, index) => (
              <li
                key={command.id}
                id={optionId(command)}
                role="option"
                aria-selected={index === activeIndex}
                className={`palette-option${index === activeIndex ? " palette-option--active" : ""}`}
                ref={index === activeIndex ? (el) => { activeOptionRef.current = el; } : undefined}
                onClick={() => activate(command)}
              >
                <span className="icon palette-option-icon">{command.icon}</span>
                <span className="palette-option-label">{command.label}</span>
                <span className="palette-option-group">{command.group}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}