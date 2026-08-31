import type { SVGProps } from "react";
import type { HostClass } from "@lamasync/core";

function iconBase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

function filledIconBase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...props}
    />
  );
}

/** Filled app-icon family used by the cozy dashboard signal tiles. */
export function IconShieldFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: <path d="M12 2.2 20.3 5v5.8c0 5.4-3.4 9.4-8.3 11-4.9-1.6-8.3-5.6-8.3-11V5L12 2.2Zm-1.1 12.9 5.7-5.7-1.4-1.4-4.3 4.3-2.1-2.1-1.4 1.4 3.5 3.5Z" />,
    ...props,
  });
}

export function IconFolderFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: <path d="M2.2 6.2c0-1.2 1-2.2 2.2-2.2h5l1.8 2h8.4c1.2 0 2.2 1 2.2 2.2v9.6c0 1.2-1 2.2-2.2 2.2H4.4c-1.2 0-2.2-1-2.2-2.2V6.2Z" />,
    ...props,
  });
}

export function IconStorageFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <>
        <ellipse cx="12" cy="5" rx="8.5" ry="3" />
        <path d="M3.5 5v5c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3V5c0 1.7-3.8 3-8.5 3S3.5 6.7 3.5 5Z" />
        <path d="M3.5 10v5c0 1.7 3.8 3 8.5 3s8.5-1.3 8.5-3v-5c0 1.7-3.8 3-8.5 3s-8.5-1.3-8.5-3Z" />
      </>
    ),
    ...props,
  });
}

export function IconSyncFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <path d="M7.2 5.1A7.8 7.8 0 0 1 19.4 8H22l-3.5 3.5L15 8h2.1a5.4 5.4 0 0 0-8.5-1.1L7.2 5.1ZM4.1 12.5 8 16h-2.1a5.4 5.4 0 0 0 8.5 1.1l1.4 1.8A7.8 7.8 0 0 1 3.6 16H1l3.1-3.5Zm2.2-2.2-3.1 3.5H6c.6-1 1.3-1.8 2.3-2.4l-2-1.1Zm11.4 3.4c-.6 1-1.3 1.8-2.3 2.4l2 1.1 3.1-3.5h-2.8Z" />
    ),
    ...props,
  });
}

export function IconHostFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <>
        <path d="M4 3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z" />
        <path d="M11 17h2v4h-2z" />
        <path d="M7 21h10v2H7z" />
      </>
    ),
    ...props,
  });
}

export function IconDotfileFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <path
        fillRule="evenodd"
        d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm6 10a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
      />
    ),
    ...props,
  });
}

export function IconHomeFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <path
        fillRule="evenodd"
        d="M12 2 3 9v10a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V9l-9-7Zm-2 13h4v7h-4z"
      />
    ),
    ...props,
  });
}

export function IconConflictFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <path
        fillRule="evenodd"
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM11 9h2v5h-2V9Zm0 7h2v2h-2v-2Z"
      />
    ),
    ...props,
  });
}

export function IconSearchFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <>
        <path
          fillRule="evenodd"
          d="M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 3.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"
        />
        <path d="M15.5 15.5 21 21l-1.5 1.5-5.5-5.5z" />
      </>
    ),
    ...props,
  });
}

export function IconPresetsFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
    ...props,
  });
}

export function IconActivityFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <path d="M2 12h4l3-9 6 18 3-9h4v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9Z" />
    ),
    ...props,
  });
}

export function IconNotificationFilled(props: SVGProps<SVGSVGElement>) {
  return filledIconBase({
    children: (
      <>
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9Z" />
        <path d="M10.5 20.5h3v1.5h-3z" />
      </>
    ),
    ...props,
  });
}

export function IconHost(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </>
    ),
    ...props,
  });
}

// LAMA-298: per-class host icons so a laptop, server, phone, NAS, etc. are
// visually distinct across the fleet UI. `HostClassIcon` picks the glyph for
// a host's class (falling back to the generic IconHost for `unknown`).
export function IconServer(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="2" y="3" width="20" height="7" rx="2" />
        <rect x="2" y="14" width="20" height="7" rx="2" />
        <line x1="6" y1="6.5" x2="6.01" y2="6.5" />
        <line x1="6" y1="17.5" x2="6.01" y2="17.5" />
      </>
    ),
    ...props,
  });
}

export function IconDesktop(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <line x1="8" y1="20" x2="16" y2="20" />
        <line x1="12" y1="16" x2="12" y2="20" />
      </>
    ),
    ...props,
  });
}

export function IconLaptop(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="3" y="4" width="18" height="11" rx="2" />
        <path d="M2 19l1.2-2.4a1 1 0 0 1 .9-.55h15.8a1 1 0 0 1 .9.55L22 19H2z" />
      </>
    ),
    ...props,
  });
}

export function IconNas(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="6" y="2" width="12" height="20" rx="2" />
        <line x1="9" y1="7" x2="15" y2="7" />
        <line x1="9" y1="11" x2="15" y2="11" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </>
    ),
    ...props,
  });
}

export function IconPhone(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </>
    ),
    ...props,
  });
}

export function IconTablet(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="5" y="2" width="14" height="20" rx="2" />
        <line x1="12" y1="18" x2="12.01" y2="18" />
      </>
    ),
    ...props,
  });
}

/** Icon for a host's class; falls back to the generic IconHost for unknown. */
export function HostClassIcon({
  hostClass,
  ...props
}: SVGProps<SVGSVGElement> & { hostClass?: HostClass | null }) {
  switch (hostClass ?? "unknown") {
    case "server":
      return <IconServer {...props} />;
    case "desktop":
      return <IconDesktop {...props} />;
    case "laptop":
      return <IconLaptop {...props} />;
    case "nas":
      return <IconNas {...props} />;
    case "phone":
      return <IconPhone {...props} />;
    case "tablet":
      return <IconTablet {...props} />;
    default:
      return <IconHost {...props} />;
  }
}

export function IconFolder(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </>
    ),
    ...props,
  });
}

export function IconDotfile(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <polyline points="14 2 14 8 20 8" />
        <circle cx="10" cy="16" r="1.5" fill="currentColor" stroke="none" />
      </>
    ),
    ...props,
  });
}

export function IconStorage(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v6c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        <path d="M3 11v6c0 1.66 4 3 9 3s9-1.34 9-3v-6" />
      </>
    ),
    ...props,
  });
}

export function IconConflict(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </>
    ),
    ...props,
  });
}

export function IconActivity(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </>
    ),
    ...props,
  });
}

export function IconNotification(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </>
    ),
    ...props,
  });
}

export function IconHome(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </>
    ),
    ...props,
  });
}

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>
    ),
    ...props,
  });
}

// LAMA-263: app-presets gallery (a 2x2 grid). Mirrors the iconBase style.
export function IconPresets(props: SVGProps<SVGSVGElement>) {
  return iconBase({
    children: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    ...props,
  });
}
