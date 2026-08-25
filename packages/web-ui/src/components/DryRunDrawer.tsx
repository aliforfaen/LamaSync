// LAMA-257: "Preview next run" drawer. Renders the result of a daemon-side
// `rclone --dry-run` for one assignment: would-transfer / would-delete
// counts and a capped file list. The dry run never changes files; the
// drawer says so explicitly. Close via the × button, the backdrop, or Esc.

import type { DryRunDetails } from "../dry-run.ts";
import { capList } from "../dry-run.ts";

export type DryRunState =
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; details: DryRunDetails };

interface DryRunDrawerProps {
  open: boolean;
  folderName: string;
  state: DryRunState | null;
  onClose: () => void;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "delete":
      return "delete";
    case "mkdir":
      return "mkdir";
    default:
      return "copy";
  }
}

export function DryRunDrawer({ open, folderName, state, onClose }: DryRunDrawerProps) {
  if (!open || !state) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview next run for ${folderName}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h2>Preview next run</h2>
            <span className="muted">{folderName}</span>
          </div>
          <button
            type="button"
            className="action drawer-close"
            aria-label="Close preview"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="drawer-body">
          {state.status === "running" ? (
            <p className="muted">
              Waiting for the dry run to finish on the device — nothing is
              being changed. This usually takes a few seconds.
            </p>
          ) : null}

          {state.status === "error" ? (
            <div className="error">{state.message}</div>
          ) : null}

          {state.status === "done" ? (
            <>
              <p className="muted">
                This is what the next sync would do — nothing is changed.
              </p>
              <div className="dry-run-counts">
                <span className="count">{state.details.wouldCopy.length} would-copy</span>
                <span className="count">{state.details.wouldDelete.length} would-delete</span>
                <span className="count">{state.details.wouldMkdir.length} would-mkdir</span>
              </div>
              {(() => {
                const all = [
                  ...state.details.wouldCopy.map((path) => ({ kind: "copy", path })),
                  ...state.details.wouldDelete.map((path) => ({ kind: "delete", path })),
                  ...state.details.wouldMkdir.map((path) => ({ kind: "mkdir", path })),
                ];
                const { items, total } = capList(all, 200);
                if (total === 0) {
                  return <p className="muted">No changes — the folders are already in sync.</p>;
                }
                return (
                  <>
                    <ul className="dry-run-files">
                      {items.map((entry, i) => (
                        <li key={`${entry.kind}:${entry.path}:${i}`}>
                          <span className={`dry-run-kind dry-run-kind--${entry.kind}`}>
                            {kindLabel(entry.kind)}
                          </span>
                          <code>{entry.path}</code>
                        </li>
                      ))}
                    </ul>
                    {total > items.length ? (
                      <p className="muted">… showing the first {items.length} of {total}.</p>
                    ) : null}
                  </>
                );
              })()}
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
