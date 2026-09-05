// Workstream 2 (onboarding): first-run checklist on the Command Center.
// Five steps derived from data the Dashboard already fetches; steps
// auto-check as conditions become true, the card hides when all five are
// done, and a dismiss button persists to localStorage. No new dependencies.

import { useState } from "react";
import { Link } from "react-router-dom";
import type { Backend, Folder, Host } from "@lamasync/core";
import { IconDotfileFilled, IconHostFilled, IconShieldFilled, IconSyncFilled } from "./icons.tsx";

const DISMISS_KEY = "lamasync_getting_started_dismissed";

function readDismissed(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(DISMISS_KEY) === "1";
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

  const complete = hosts.length > 0 && backends.length > 0 && folders.length > 0 && hasAssignments && hasOperations;
  if (dismissed || complete) return null;

  function dismiss(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DISMISS_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <section className="section getting-started outcome-onboarding">
      <div className="toolbar onboarding-heading">
        <div><h2>Make LamaSync useful</h2><p className="muted">Choose the outcome you want first. The technical details can wait.</p></div>
        <button type="button" className="action" onClick={dismiss}>Dismiss</button>
      </div>
      <div className="outcome-grid">
        <OutcomeCard icon={<IconSyncFilled />} title="Keep a folder in sync" body="Choose a folder and the Devices that should share it." to="/folders" />
        <OutcomeCard icon={<IconShieldFilled />} title="Protect a folder with backups" body="Choose what to protect, where it lives, and when it runs." to="/backups" />
        <OutcomeCard icon={<IconDotfileFilled />} title="Protect an app’s settings" body="Enroll an app template on a device so its settings are captured as snapshots." to="/apps/templates" />
        <OutcomeCard icon={<IconHostFilled />} title="Connect another Device" body="Pair the next machine and confirm it has joined the fleet." to="/hosts" />
      </div>
    </section>
  );
}

function OutcomeCard({ icon, title, body, to }: { icon: JSX.Element; title: string; body: string; to: string }) {
  return <Link className="outcome-card" to={to}><span className="outcome-icon" aria-hidden="true">{icon}</span><span><strong>{title}</strong><small>{body}</small></span><span className="outcome-arrow" aria-hidden="true">→</span></Link>;
}
