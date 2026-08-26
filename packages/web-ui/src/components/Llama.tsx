// LAMA-265: the hopping-llama brand glyph, drawn inline as SVG in
// currentColor — no emoji, no image assets, consistent with icons.tsx and
// EmptyState. It is a delight accent for the calm-homelab voice, used where
// it earns its place (empty states at first boot), never a mascot invasion.
//
// The pose is mid-hop: ears up, front legs reaching forward, back legs
// kicked out, and a small arc under the hooves. Stroke-only (like the rest
// of the icon family) so it inherits color and stays crisp at 24-48px.

import type { SVGProps } from "react";

export interface LlamaProps extends SVGProps<SVGSVGElement> {
  /** Glyph size in px. Default 32 — the scale the hop pose reads best at. */
  size?: number;
}

export function Llama({ size = 32, ...props }: LlamaProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {/* ears */}
      <path d="M22.5 3.5 23.75 8" />
      <path d="M26.5 3.5 25.5 8" />
      {/* head */}
      <ellipse cx="24.75" cy="11.5" rx="4" ry="2.75" />
      {/* neck */}
      <path d="M21.75 14c-.35 2.8 1.05 4.4-.5 7.5" />
      {/* body */}
      <path d="M20.5 21.75C17.75 20.5 13.5 20.5 11.25 22.25 9.25 23.75 9.5 26 11.5 26.5h7c1.75 0 2.75-1.5 2.75-3.25 0-1-.5-1.25-.75-1.5z" />
      {/* tail */}
      <path d="M11.25 21.75c-1.75-.75-3.25-.25-3.75 1.5" />
      {/* legs — hop spread */}
      <path d="M20.25 25.5 25.5 29" />
      <path d="M18.75 26 23.5 30" />
      <path d="M12.5 25.25 7.5 28.5" />
      <path d="M14.25 26 10 30" />
      {/* hop arc */}
      <path d="M7 30.25Q16 32 25.75 29.5" />
    </svg>
  );
}