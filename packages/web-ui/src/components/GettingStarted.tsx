// Workstream 2 (onboarding): first-run checklist on the Command Center.
// Five steps derived from data the Dashboard already fetches; steps
// auto-check as conditions become true, the card hides when all five are
// done, and a dismiss button persists to localStorage. No new dependencies.

import { useState } from "react";
import { Link } from "react-router-dom";
import type { Backend, Folder, Host } from "@lamasync/core";

const DISMISS_KEY = "lamasync_getting_started_dismissed";

function readDismissed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(DISMISS_KEY) === "1";
}

interface Step {
  label: string;
  done: boolean;
  to: string;
}

interface Props {
  hosts: Host[];
  backends: Backend[];
  folders: Folder[];
  hasAssignments: boolean;
  hasOperations: boolean;
}

export function GettingStarted({
  hosts,
  backends,
  folders,
  hasAssignments,
  hasOperations,
}: Props) {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  const steps: Step[] = [
    { label: "Register a host", done: hosts.length > 0, to: "/hosts" },
    { label: "Create a backend", done: backends.length > 0, to: "/backends" },
    { label: "Create a folder", done: folders.length > 0, to: "/folders" },
    { label: "Assign it to a host", done: hasAssignments, to: "/folders" },
    { label: "Trigger your first sync", done: hasOperations, to: "/hosts" },
  ];

  if (dismissed || steps.every((s) => s.done)) return null;

  const pendingCount = steps.filter((s) => !s.done).length;

  function dismiss(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DISMISS_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <section className="section getting-started">
      <div className="toolbar">
        <h2>Getting started</h2>
        <span className="muted">{pendingCount} step(s) left</span>
        <button type="button" className="action" onClick={dismiss}>
          Dismiss
        </button>
      </div>
      <ol className="getting-started-list">
        {steps.map((step, index) => (
          <li key={step.label} className={step.done ? "gs-done" : undefined}>
            <span className="gs-marker" aria-hidden="true">
              {step.done ? "✓" : index + 1}
            </span>
            {step.done ? (
              <span className="muted">{step.label}</span>
            ) : (
              <Link to={step.to}>{step.label}</Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
