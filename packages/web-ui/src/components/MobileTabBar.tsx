import { useEffect, useRef, useState, type RefObject } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { moreGroups, moreRoutesActive, quickItems, type NavGroup } from "./Nav.tsx";
import { ShellActions } from "./ShellActions.tsx";
import { IconMoreFilled } from "./icons.tsx";

export interface MoreSheetProps {
  groups: NavGroup[];
  onClose: () => void;
  closeButtonRef?: RefObject<HTMLButtonElement>;
}

/**
 * The phone's overflow sheet: every destination the tab bar does not show,
 * plus the shell actions the rail footer would otherwise hold.
 *
 * Exported separately from [MobileTabBar] because the sheet is only mounted
 * while open, so a static render of the bar alone can never assert its
 * contents. Split out, the destination list and the dialog semantics are
 * testable directly.
 */
export function MoreSheet({ groups, onClose, closeButtonRef }: MoreSheetProps) {
  return (
    <>
      <button
        type="button"
        className="sheet-backdrop"
        aria-label="Close more destinations"
        onClick={onClose}
      />
      <div
        id="mobile-more-sheet"
        className="mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="More destinations"
      >
        <div className="mobile-sheet-head">
          <h2>More</h2>
          <button
            type="button"
            ref={closeButtonRef}
            className="sheet-close"
            aria-label="Close more destinations"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="mobile-sheet-groups">
          {groups.map((group) => (
            <div className="rail-group" key={group.label}>
              <div className="rail-group-label">{group.label}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} onClick={onClose}>
                  {item.icon} {item.text}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        <div className="mobile-sheet-actions">
          <ShellActions variant="sheet" />
        </div>
      </div>
    </>
  );
}

/**
 * LAMA-329 phase 3: the phone's navigation surface (below 640px).
 *
 * Four destinations stay in the bar; everything else lives in the More sheet,
 * together with the shell actions the rail would otherwise have held. Both
 * sets are derived from `GROUPS`, so the phone and the rail cannot drift.
 *
 * History semantics are deliberately UNCHANGED: every destination is a
 * `NavLink` that pushes a hash entry, exactly as the rail does. That keeps
 * browser back, Android back (the native shell drives `WebView.goBack`, so it
 * walks this same history) and deep links behaving the way they already do.
 * Switching tabs with `replace` would have been a silent change to the back
 * contract.
 */
export function MobileTabBar() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const { pathname } = useLocation();
  const sheetCloseRef = useRef<HTMLButtonElement>(null);

  const quick = quickItems();
  const groups = moreGroups();
  const moreActive = moreRoutesActive(pathname);

  // A destination tap has already navigated; an open sheet would sit over the
  // page the user just asked for.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    // The page behind a modal sheet must not scroll under it.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetCloseRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [sheetOpen]);

  return (
    <>
      <nav className="mobile-tabbar" aria-label="Primary destinations">
        {quick.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            {item.icon}
            <span className="mobile-tabbar-label">{item.text}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={`mobile-tabbar-more${moreActive ? " active" : ""}`}
          aria-expanded={sheetOpen}
          aria-haspopup="dialog"
          aria-controls="mobile-more-sheet"
          onClick={() => setSheetOpen((open) => !open)}
        >
          <IconMoreFilled />
          <span className="mobile-tabbar-label">More</span>
        </button>
      </nav>

      {sheetOpen ? (
        <MoreSheet
          groups={groups}
          closeButtonRef={sheetCloseRef}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </>
  );
}
