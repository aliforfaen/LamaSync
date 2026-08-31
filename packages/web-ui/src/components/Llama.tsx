// LAMA-265: the hopping-llama brand glyph, drawn inline as SVG in
// currentColor — no emoji, no image assets, consistent with icons.tsx and
// EmptyState. It is a delight accent for the calm-homelab voice, used where
// it earns its place (empty states at first boot), never a mascot invasion.
//
// The default pose is mid-hop: ears up, front legs reaching forward, back
// legs kicked out, and a small arc under the hooves. Stroke-only (like the
// rest of the icon family) so it inherits color and stays crisp at 24-48px.
//
// LAMA-274: two additional poses for the rest of the delight surface.
//   - "sit" — resting: body lowered to the ground, legs tucked, tail curled
//     around. Used for calmer empty states (first destinations, etc.).
//   - "nap" — sleeping: the sitting pose plus a closed eye and a small "z".
//     Reserved for a FUTURE loading slot (e.g. a Dashboard skeleton). It is
//     exported but not yet wired anywhere — see the LAMA-274 comment in
//     index.css if a loading state arrives.
//   - "drift" (LAMA-295) — floating under an umbrella; the quiet empty/loading
//     treatment the cozy dashboard brief calls for. Used by the Dashboard's
//     empty-fleet state.

import type { SVGProps } from "react";

export type LlamaPose = "hop" | "drift" | "sit" | "nap";

export interface LlamaProps extends SVGProps<SVGSVGElement> {
  /** Glyph size in px. Default 32 — the scale the hop pose reads best at. */
  size?: number;
  /** LAMA-274: which pose to draw. Default "hop" (the original glyph). */
  pose?: LlamaPose;
}

/** Shared head + neck for the seated/sleeping poses. */
function SittingHead() {
  return (
    <>
      {/* ears — relaxed */}
      <path d="M22 3.5 23 8" />
      <path d="M26 3.5 25.25 8" />
      {/* head */}
      <ellipse cx="24.5" cy="11.5" rx="4" ry="2.75" />
      {/* neck — shorter, head resting lower */}
      <path d="M22 14c-.35 2.6.9 4.1-.25 6.75" />
    </>
  );
}

export function Llama({ size = 32, pose = "hop", ...props }: LlamaProps) {
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
      {pose === "hop" ? (
        <>
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
        </>
      ) : pose === "drift" ? (
        <>
          {/* umbrella canopy + scalloped hem, floating over the head */}
          <path d="M18 8.5c0-3.5 3-6 6.5-6s6.5 2.5 6.5 6" />
          <path d="M18 8.5c1-1.3 2.25-1.3 3.25 0s2.25 1.3 3.25 0 2.25 1.3 3.25 0 2.25 1.3 3.25 0" />
          <path d="M24.5 8.5v3.5" />
          <path d="M24.5 12c0 1.5-2 1.5-2 0" />
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
          {/* legs — dangling while drifting */}
          <path d="M19.5 26.5V30" />
          <path d="M17.75 26.5V30.5" />
          <path d="M12.25 26.25V29.5" />
          <path d="M13.75 26.25V30" />
          {/* drift cue */}
          <path d="M14 31.5h2M18 31.5h2" />
        </>
      ) : (
        <>
          <SittingHead />
          {/* body — low and grounded, tucked legs */}
          <path d="M21.5 20.75C18.75 19.75 14.5 19.75 12.25 21.25 10.5 22.5 10.25 24.5 12 25.25h6.75c1.75 0 2.75-1.25 2.75-2.75 0-.75-.4-1.25-.75-1.5z" />
          {/* tail — curled around */}
          <path d="M12.25 21.25c-1.5-1-3-.5-3.5 1.25" />
          {/* front legs — tucked under */}
          <path d="M19.5 24.75 22.25 28.5" />
          <path d="M18 25.25 20.5 29.25" />
          {/* back legs — folded under */}
          <path d="M13.75 24.75 11 28.5" />
          <path d="M15.25 25.25 13.5 29.25" />
          {pose === "nap" ? (
            <>
              {/* closed eye */}
              <path d="M23.75 11.25 25.5 12.5" />
              {/* little zzz drifting up */}
              <path d="M27.75 6.5 27.75 5 29.5 5 27.75 7.5 29.5 7.5" />
            </>
          ) : null}
        </>
      )}
    </svg>
  );
}
