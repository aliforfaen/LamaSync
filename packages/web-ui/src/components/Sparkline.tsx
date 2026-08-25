// Tiny inline-SVG sparkline (LAMA-269). No chart dependency — just a
// polyline scaled into a fixed box, with an optional area fill. The geometry
// lives in the pure `sparklinePoints` helper so it can be unit-tested
// without rendering.

export interface SparklineProps {
  /** Y values in series order (e.g. bytes over time). */
  data: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  className?: string;
  ariaLabel?: string;
}

/**
 * Map a series to SVG coordinates. Pure + tested.
 * `min`/`max` fix the y-range (pass `min: 0` to anchor at zero); when omitted
 * the data's own extent is used and a flat series is centred.
 */
export function sparklinePoints(
  data: number[],
  width: number,
  height: number,
  min?: number,
  max?: number,
): Array<[number, number]> {
  if (data.length === 0) return [];
  const lo = min ?? Math.min(...data);
  const hi = max ?? Math.max(...data);
  const span = hi - lo;
  const n = data.length;
  const stepX = n === 1 ? 0 : width / (n - 1);
  return data.map((v, i) => {
    const x = i * stepX;
    const y = span === 0 ? height / 2 : height - ((v - lo) / span) * height;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  strokeWidth = 2,
  className,
  ariaLabel,
}: SparklineProps) {
  const pts = sparklinePoints(data, width, height);
  if (pts.length === 0) return null;
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area =
    pts.length > 1 ? `${line} L${width},${height} L0,${height} Z` : "";
  return (
    <svg
      className={className ? `sparkline ${className}` : "sparkline"}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel ?? "growth trend"}
      preserveAspectRatio="none"
    >
      {area ? <path d={area} className="spark-area" /> : null}
      <path d={line} fill="none" strokeWidth={strokeWidth} className="spark-line" />
    </svg>
  );
}
