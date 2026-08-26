// LAMA-265: once-per-milestone confetti burst.
//
// `useMilestoneConfetti(id)` is the trigger: call `fire()` when a milestone
// condition is met (first successful backup on the Dashboard, first
// app-settings backup from Presets…). The localStorage gate
// `lamasync.milestone.<id>` guarantees the burst fires EXACTLY once ever —
// reload-safe, and a no-op on repeat events or failures.
//
// `<Confetti />` is the visual: pure-CSS particles driven by transform
// keyframes (`.confetti-*` in index.css), ~1.2s, auto-cleanup once the last
// particle lands. Under `prefers-reduced-motion` it renders a static
// fallback line (or nothing) instead of particles — the milestone is still
// marked so it never replays later.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { prefersReducedMotion } from "../motion.ts";

// Re-exported so callers/tests keep importing the motion gate from one
// obvious place; the implementation lives in ../motion.ts (P-A).
export { prefersReducedMotion };

export const MILESTONE_PREFIX = "lamasync.milestone.";
const PARTICLE_COUNT = 28;
/** CSS animation duration, seconds (matches `confetti-fly` in index.css). */
const BURST_S = 1.2;
/** How long the reduced-motion fallback line stays up. */
const STATIC_MS = 2600;

export function milestoneKey(id: string): string {
  return `${MILESTONE_PREFIX}${id}`;
}

/** True once the milestone id has already been marked (reload-safe). */
export function milestoneAlreadyFired(id: string): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(milestoneKey(id)) === "1";
}

/**
 * Check-and-set the once-ever gate for a milestone. Returns true only on the
 * first call for this id, and persists it so a reload never replays the
 * burst. Storage unavailable or blocked → false: a milestone must never
 * repeat, and firing without a way to remember would repeat next visit.
 */
export function tryFireMilestone(id: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    if (localStorage.getItem(milestoneKey(id)) === "1") return false;
    localStorage.setItem(milestoneKey(id), "1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Milestone trigger: `fire()` marks the milestone and shows the confetti,
 * but only on the first-ever call. Returns `{ fire, visible }` — render
 * `<Confetti />` while `visible` is true.
 */
export function useMilestoneConfetti(milestoneId: string): {
  fire: () => void;
  visible: boolean;
} {
  const [visible, setVisible] = useState(false);
  const fire = useCallback(() => {
    if (tryFireMilestone(milestoneId)) setVisible(true);
  }, [milestoneId]);
  return { fire, visible };
}

interface Particle {
  dx: number; // vw
  dy: number; // vh
  rot: number; // deg
  delay: number; // s
  scale: number;
  color: string;
  w: number;
  h: number;
}

/** Seeded PRNG so the burst is identical across StrictMode double-renders. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semantic tokens, so particles adapt to both themes. */
const CONFETTI_COLORS = [
  "var(--accent-info)",
  "var(--accent-ok)",
  "var(--accent-warn)",
  "var(--accent-storage)",
  "var(--accent-sync)",
];

function makeParticles(count: number): Particle[] {
  const rand = mulberry32(0x1a265);
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 16 + rand() * 26; // 16..42 vw/vh
    out.push({
      dx: Math.cos(angle) * dist,
      dy: Math.sin(angle) * dist,
      rot: (rand() - 0.5) * 720,
      delay: rand() * 0.25,
      scale: 0.6 + rand() * 0.9,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
      w: 5 + Math.round(rand() * 4),
      h: 10 + Math.round(rand() * 6),
    });
  }
  return out;
}

type CssVars = Record<`--${string}`, string | number>;

function particleStyle(p: Particle): CSSProperties {
  const vars: CssVars = {
    "--dx": `${p.dx}vw`,
    "--dy": `${p.dy}vh`,
    "--rot": `${p.rot}deg`,
    "--delay": `${p.delay}s`,
    "--scale": String(p.scale),
  };
  return {
    ...vars,
    width: `${p.w}px`,
    height: `${p.h}px`,
    background: p.color,
    animationDelay: `${p.delay}s`,
  };
}

export interface ConfettiProps {
  /** Rendered instead of particles under prefers-reduced-motion. */
  fallback?: ReactNode;
  /** Override the motion gate (tests/SSR); defaults to prefersReducedMotion(). */
  reduced?: boolean;
}

export function Confetti({ fallback, reduced }: ConfettiProps) {
  const reduceMotion = reduced ?? prefersReducedMotion();
  const [gone, setGone] = useState(false);
  const pending = useRef(PARTICLE_COUNT);
  const particles = useMemo(() => makeParticles(PARTICLE_COUNT), []);
  const maxDelay = useMemo(
    () => particles.reduce((m, p) => Math.max(m, p.delay), 0),
    [particles],
  );

  // Deterministic cleanup: the last particle lands at maxDelay + BURST_S.
  // The timeout is also the safety net if animationend never fires.
  useEffect(() => {
    const ms = reduceMotion ? STATIC_MS : (maxDelay + BURST_S) * 1000 + 250;
    const timer = setTimeout(() => setGone(true), ms);
    return () => clearTimeout(timer);
  }, [reduceMotion, maxDelay]);

  if (reduceMotion) {
    if (gone || fallback === undefined) return null;
    return (
      <div className="confetti-static" role="status">
        {fallback}
      </div>
    );
  }

  if (gone) return null;

  const onParticleDone = () => {
    pending.current -= 1;
    if (pending.current <= 0) setGone(true);
  };

  return (
    <div className="confetti" aria-hidden="true">
      {particles.map((p, i) => (
        <span
          key={i}
          className="confetti-bit"
          style={particleStyle(p)}
          onAnimationEnd={onParticleDone}
        />
      ))}
    </div>
  );
}