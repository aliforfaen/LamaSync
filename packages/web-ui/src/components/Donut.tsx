// Inline-SVG donut (LAMA-269). No chart dependency — each slice is one
// <circle> with a stroke-dasharray arc, coloured from the design tokens.
// The geometry lives in the pure `donutSlices` helper so it can be unit-
// tested (aggregation + arc math) without rendering.

export interface DonutSlice {
  label: string;
  value: number;
  color?: string;
}

export interface DonutProps {
  /** One entry per slice (e.g. a destination's folders). */
  data: DonutSlice[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSublabel?: string;
  className?: string;
  ariaLabel?: string;
}

// Slice colours pulled from the design tokens so they adapt to light/dark.
const PALETTE = [
  "var(--accent-storage)",
  "var(--accent-sync)",
  "var(--accent-info)",
  "var(--accent-ok)",
  "var(--accent-warn)",
  "var(--accent-critical)",
  "var(--accent-primary)",
];

export interface DonutArc {
  color: string;
  /** stroke-dasharray "len gap" for one slice. */
  dash: string;
  /** stroke-dashoffset to rotate the slice to its start angle. */
  offset: number;
  value: number;
  label: string;
  fraction: number;
}

/**
 * Compute SVG arc geometry for each positive-value slice. Pure + tested.
 * Returns one arc per slice, or [] when there is no positive total (so
 * callers can render a flat "unmeasured" state instead of a fake zero).
 */
export function donutSlices(
  data: DonutSlice[],
  size: number,
  thickness: number,
): DonutArc[] {
  const positive = data.filter((d) => d.value > 0);
  const total = positive.reduce((acc, d) => acc + d.value, 0);
  if (total <= 0) return [];
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let acc = 0;
  return positive.map((d, i) => {
    const fraction = d.value / total;
    const len = fraction * circumference;
    const arc: DonutArc = {
      color: d.color ?? PALETTE[i % PALETTE.length],
      dash: `${len.toFixed(2)} ${(circumference - len).toFixed(2)}`,
      offset: Number((-acc * circumference).toFixed(2)),
      value: d.value,
      label: d.label,
      fraction,
    };
    acc += fraction;
    return arc;
  });
}

export function Donut({
  data,
  size = 64,
  thickness = 10,
  centerLabel,
  centerSublabel,
  className,
  ariaLabel,
}: DonutProps) {
  const slices = donutSlices(data, size, thickness);
  const c = size / 2;
  const r = (size - thickness) / 2;
  return (
    <span
      className={className ? `donut ${className}` : "donut"}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel ?? centerLabel ?? "storage breakdown"}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r} fill="none" className="donut-track" strokeWidth={thickness} />
        {slices.map((s, i) => (
          <circle
            key={i}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={thickness}
            strokeDasharray={s.dash}
            strokeDashoffset={s.offset}
            transform={`rotate(-90 ${c} ${c})`}
          />
        ))}
      </svg>
      {centerLabel ? <span className="donut-center">{centerLabel}</span> : null}
      {centerSublabel ? <span className="donut-sub">{centerSublabel}</span> : null}
    </span>
  );
}
