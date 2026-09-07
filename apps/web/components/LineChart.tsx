'use client';
// A real-time line chart that stays sharp.
//
// The SVG viewBox matches the element's measured pixel size 1:1, so nothing is
// scaled after layout; the stroke is pinned with vector-effect so it is exactly
// its nominal width at any size; gridlines sit on half-pixels so a 1px rule is
// one crisp row rather than two half-lit ones.
import { buildSeriesPath, niceTicks, crisp, type Point } from '../lib/chart';
import { useSize } from '../lib/useSize';

export interface LineChartProps {
  points: Point[];
  /** Tailwind text-* class; the line inherits it via currentColor. */
  tone?: string;
  height?: number;
  /** Format a y-axis label. */
  formatY?: (v: number) => string;
  /** Draw a reference line at this y value (e.g. break-even). */
  baselineAt?: number | null;
  fill?: boolean;
  label?: string;
}

export function LineChart({
  points, tone = 'text-accent', height = 120,
  formatY = (v) => v.toFixed(2), baselineAt = null, fill = true, label,
}: LineChartProps) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = size.width || 0;
  const box = { width, height, padL: 44, padR: 8, padT: 8, padB: 4 };
  const { d, area, y, domainY } = buildSeriesPath(points, box);
  const ticks = width ? niceTicks(domainY[0], domainY[1], 3) : [];

  return (
    <div ref={ref} className="w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={label ?? 'chart'}
          className={tone}
        >
          {/* value grid — quiet enough never to compete with the series */}
          {ticks.map((t) => {
            const yy = crisp(y(t));
            return (
              <g key={t}>
                <line
                  x1={box.padL} x2={width - box.padR} y1={yy} y2={yy}
                  stroke="currentColor" strokeWidth="1"
                  className="text-grid" shapeRendering="crispEdges"
                />
                <text
                  x={box.padL - 8} y={yy} dy="0.32em" textAnchor="end"
                  className="fill-ink-faint font-mono text-xs tabular-nums"
                >
                  {formatY(t)}
                </text>
              </g>
            );
          })}

          {baselineAt !== null && baselineAt >= domainY[0] && baselineAt <= domainY[1] ? (
            <line
              x1={box.padL} x2={width - box.padR}
              y1={crisp(y(baselineAt))} y2={crisp(y(baselineAt))}
              stroke="currentColor" strokeWidth="1" strokeDasharray="2 3"
              className="text-ink-faint" shapeRendering="crispEdges"
            />
          ) : null}

          {fill && area ? (
            <path d={area} fill="currentColor" opacity="0.10" />
          ) : null}
          {d ? (
            <path
              d={d} fill="none" stroke="currentColor" strokeWidth="1.75"
              strokeLinejoin="round" strokeLinecap="round"
              // The stroke keeps its width no matter how the SVG is sized.
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}
