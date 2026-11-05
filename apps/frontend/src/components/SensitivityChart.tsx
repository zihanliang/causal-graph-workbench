import type { RobustnessSummary } from "@causal-graph-workbench/shared";
import { useState } from "react";

const WIDTH = 420;
const HEIGHT = 250;
const MARGIN = { top: 10, right: 14, bottom: 42, left: 46 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const MAX_LABELS = 4;
/** Labels narrower than this overlap: at this font size a typical name is about 7 units per character. */
const LABEL_CHAR_WIDTH = 6.4;
const LABEL_HEIGHT = 14;

function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function tickLabel(value: number): string {
  return `${Number((value * 100).toFixed(1))}%`;
}

function niceMaximum(value: number): number {
  const steps = [0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1];
  return steps.find((step) => step >= value) ?? 1;
}

function tickStep(maximum: number): number {
  return maximum <= 0.05 ? 0.01 : maximum <= 0.1 ? 0.02 : maximum <= 0.2 ? 0.05 : maximum <= 0.5 ? 0.1 : 0.2;
}

interface PlacedLabel {
  variable: string;
  x: number;
  y: number;
  anchor: "start" | "end";
}

/** Direct labels for the strongest few, skipping any that would run into a label already placed. */
function placeLabels(points: { variable: string; x: number; y: number }[]): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  const spanOf = (label: PlacedLabel) => {
    const width = label.variable.length * LABEL_CHAR_WIDTH;
    return label.anchor === "start" ? [label.x, label.x + width] : [label.x - width, label.x];
  };
  for (const point of points.slice(0, MAX_LABELS)) {
    const width = point.variable.length * LABEL_CHAR_WIDTH;
    const fitsRight = point.x + 9 + width <= WIDTH - MARGIN.right;
    const label: PlacedLabel = {
      variable: point.variable,
      x: fitsRight ? point.x + 9 : point.x - 9,
      y: point.y + 4,
      anchor: fitsRight ? "start" : "end",
    };
    const [left, right] = spanOf(label);
    const collides = placed.some((other) => {
      const [otherLeft, otherRight] = spanOf(other);
      return Math.abs(other.y - label.y) < LABEL_HEIGHT && left < otherRight && otherLeft < right;
    });
    if (!collides) {
      placed.push(label);
    }
  }
  return placed;
}

/**
 * Where something unmeasured would have to sit to explain away the effect, with the variables you did
 * measure placed on the same scale. The same blue as the what-if arrows on the graph, because this is one too.
 */
export function SensitivityChart({ robustness }: { robustness: RobustnessSummary }) {
  const [active, setActive] = useState<string | null>(null);
  const { ratio, value, benchmarks } = robustness;

  const strongest = Math.max(value * 1.7, ...benchmarks.flatMap((item) => [item.treatmentShare, item.outcomeShare]).map((share) => share * 1.15));
  const maximum = niceMaximum(Math.min(strongest, 1));
  const toX = (share: number) => MARGIN.left + (Math.min(share, maximum) / maximum) * PLOT_WIDTH;
  const toY = (share: number) => MARGIN.top + PLOT_HEIGHT - (Math.min(share, maximum) / maximum) * PLOT_HEIGHT;

  // The curve y = ratio (1 - x) / x, kept to the part inside the plot.
  const curve: [number, number][] = [];
  const pointCount = 120;
  for (let index = 0; index <= pointCount; index += 1) {
    const x = (maximum * (index + 0.5)) / (pointCount + 0.5);
    const y = (ratio * (1 - x)) / x;
    if (y <= maximum) {
      curve.push([x, y]);
    }
  }
  const curvePath = curve.map(([x, y], index) => `${index ? "L" : "M"}${toX(x).toFixed(1)},${toY(y).toFixed(1)}`).join("");
  const region = curve.length
    ? `${curvePath}L${toX(maximum).toFixed(1)},${toY(curve[curve.length - 1][1]).toFixed(1)}L${toX(maximum).toFixed(1)},${toY(maximum).toFixed(1)}L${toX(curve[0][0]).toFixed(1)},${toY(maximum).toFixed(1)}Z`
    : "";

  const step = tickStep(maximum);
  const ticks: number[] = [];
  for (let tick = 0; tick <= maximum + 1e-9; tick += step) {
    ticks.push(Number(tick.toFixed(4)));
  }

  const points = benchmarks.map((item) => ({ ...item, x: toX(item.treatmentShare), y: toY(item.outcomeShare) }));
  const labels = placeLabels(points);
  const shown = points.find((point) => point.variable === active) ?? null;

  return (
    <figure className="chart">
      <ul className="chart__legend">
        <li>
          <svg width="18" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="18" y2="4" stroke="#2f70bb" strokeWidth="2" strokeDasharray="5 3" />
          </svg>
          Where the effect disappears
        </li>
        {points.length ? (
          <li>
            <svg width="10" height="10" aria-hidden="true">
              <circle cx="5" cy="5" r="4" fill="#131416" />
            </svg>
            Something as strong as this variable
          </li>
        ) : null}
      </ul>
      <div className="chart__plot">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`Chart of how strong something unmeasured would have to be. The effect disappears at ${percent(value)} of both treatment and outcome.`}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={toY(tick)} y2={toY(tick)} stroke="#f0f1f2" />
              <text x={MARGIN.left - 6} y={toY(tick) + 4} textAnchor="end" className="chart__tick">
                {tickLabel(tick)}
              </text>
              <text x={toX(tick)} y={MARGIN.top + PLOT_HEIGHT + 16} textAnchor="middle" className="chart__tick">
                {tickLabel(tick)}
              </text>
            </g>
          ))}
          <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={MARGIN.top + PLOT_HEIGHT} y2={MARGIN.top + PLOT_HEIGHT} stroke="#cdced1" />
          <line x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={MARGIN.top + PLOT_HEIGHT} stroke="#cdced1" />

          {region ? <path d={region} fill="#2f70bb" fillOpacity="0.07" /> : null}
          {curvePath ? <path d={curvePath} fill="none" stroke="#2f70bb" strokeWidth="2" strokeDasharray="6 4" /> : null}

          <text x={WIDTH - MARGIN.right - 6} y={MARGIN.top + 16} textAnchor="end" className="chart__region">
            Strong enough to explain it away
          </text>

          {value <= maximum ? (
            <g>
              <circle cx={toX(value)} cy={toY(value)} r="4" fill="#ffffff" stroke="#2f70bb" strokeWidth="2" />
              <text x={toX(value) + 8} y={toY(value) - 7} className="chart__annotation">
                {percent(value)} of each
              </text>
            </g>
          ) : null}

          {points.map((point) => (
            <g key={point.variable}>
              <circle cx={point.x} cy={point.y} r="4.5" fill="#131416" stroke="#ffffff" strokeWidth="2" />
              {/* A bigger target than the mark, so it is easy to land on with a finger. */}
              <circle
                cx={point.x}
                cy={point.y}
                r="14"
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={`${point.variable}: about ${percent(Math.min(point.shareOfEstimate, 1))} of the estimate`}
                onMouseEnter={() => setActive(point.variable)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(point.variable)}
                onBlur={() => setActive(null)}
              />
            </g>
          ))}
          {labels.map((label) => (
            <text key={label.variable} x={label.x} y={label.y} textAnchor={label.anchor} className="chart__label" pointerEvents="none">
              {label.variable}
            </text>
          ))}

          <text x={MARGIN.left + PLOT_WIDTH / 2} y={HEIGHT - 6} textAnchor="middle" className="chart__axis">
            Share of treatment it explains
          </text>
          <text transform={`translate(11 ${MARGIN.top + PLOT_HEIGHT / 2}) rotate(-90)`} textAnchor="middle" className="chart__axis">
            Share of outcome it explains
          </text>
        </svg>
        {shown ? (
          <div
            className="chart__tooltip"
            role="status"
            style={{
              left: `${(shown.x / WIDTH) * 100}%`,
              top: `${(shown.y / HEIGHT) * 100}%`,
              transform: shown.x > WIDTH / 2 ? "translate(calc(-100% - 12px), -50%)" : "translate(12px, -50%)",
            }}
          >
            <strong>{shown.variable}</strong>
            <span>
              {percent(shown.treatmentShare)} of treatment, {percent(shown.outcomeShare)} of outcome
            </span>
            <span>{shown.shareOfEstimate >= 1 ? "Enough to explain all of the estimate" : `About ${percent(shown.shareOfEstimate)} of the estimate`}</span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
