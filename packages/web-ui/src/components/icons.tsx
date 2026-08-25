import type { SVGProps } from "react";

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
