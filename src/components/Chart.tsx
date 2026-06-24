import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Series } from '../model/types';
import { FUEL_META, STACK_ORDER } from '../model/fuels';
import type { MonthlyAverage } from '../model/types';
import { baselineValue, type Baseline } from '../engine/recommend';

export type ChartMode = 'change' | 'mix';

interface Props {
  series: Series;
  mode: ChartMode;
  baseline: Baseline;
  monthlyAvg: MonthlyAverage | null;
  prices: Map<string, number> | null; // Agile p/kWh keyed by minute ts
  cursorIndex: number | null;
  onScrub: (index: number | null) => void;
  horizonHours: number;
}

// viewBox dimensions; the SVG scales to container width.
const W = 380;
const H = 224;
const PAD = { top: 20, right: 32, bottom: 26, left: 34 }; // gutters hold the y-axes (gCO₂ left, price right)
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const PLOT_BOTTOM = PAD.top + PLOT_H;

// A "nice" round step (1/2/5 × 10ⁿ) close to `rough`, for axis ticks. Always
// returns a positive step — a zero/NaN step would make the tick loops spin
// forever (e.g. North Scotland's intensity is ~0 gCO₂).
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function fmtTime(ts: string): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export default function Chart({
  series,
  mode,
  baseline,
  monthlyAvg,
  prices,
  cursorIndex,
  onScrub,
  horizonHours,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pressed = useRef(false);

  const layout = useMemo(() => {
    // Visible slots: the recent actual tail through `horizonHours` past now.
    const startMs = Date.parse(series.slots[series.nowIndex].ts);
    const limitMs = startMs + horizonHours * 3600 * 1000;
    const visible = series.slots
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => Date.parse(s.ts) <= limitMs);

    const firstAbs = visible[0]?.i ?? 0;
    const n = visible.length;
    const gvals = visible.map((v) => v.s.gco2);
    // Floor the domain so ultra-clean regions (e.g. North Scotland ≈ 0 gCO₂)
    // still get a sensible axis rather than a degenerate zero-height scale.
    const gMax =
      Math.max(...gvals, baselineValue(series, baseline, monthlyAvg, horizonHours), 20) * 1.12;
    const gMin = 0;

    const x = (absIndex: number) =>
      PAD.left + ((absIndex - firstAbs) / Math.max(1, n - 1)) * PLOT_W;
    const yG = (g: number) =>
      PAD.top + (1 - (g - gMin) / Math.max(1, gMax - gMin)) * PLOT_H;
    const yPct = (p: number) => PLOT_BOTTOM - (p / 100) * PLOT_H;

    const nowX = x(series.nowIndex);
    const baseLevel = baselineValue(series, baseline, monthlyAvg, horizonHours);
    const baselineY = yG(baseLevel);
    const nowY = yG(series.slots[series.nowIndex].gco2);

    return { visible, firstAbs, n, gMax, x, yG, yPct, nowX, baselineY, nowY, baseLevel };
  }, [series, baseline, monthlyAvg, horizonHours]);

  const { visible, x, yG, nowX, baselineY, nowY } = layout;

  // Split visible into past (<= now) and future (>= now) for styling.
  const futurePts = visible.filter((v) => v.i >= series.nowIndex);
  const pastPts = visible.filter((v) => v.i <= series.nowIndex);

  // Diverging-gradient stops. Anchor full colour to the actual future extremes
  // (not the plot edges) so the fill saturates over the data range and stays
  // vivid even when the curve sits well inside the axis.
  const frac = (yv: number) => Math.max(0, Math.min(1, (yv - PAD.top) / PLOT_H));
  const futureYs = futurePts.map((p) => yG(p.s.gco2));
  const baseFrac = frac(baselineY);
  const topFrac = frac(futureYs.length ? Math.min(...futureYs, baselineY) : baselineY); // dirtiest
  const botFrac = frac(futureYs.length ? Math.max(...futureYs, baselineY) : baselineY); // cleanest

  const linePath = (pts: { s: { gco2: number }; i: number }[]) =>
    pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(2)},${yG(p.s.gco2).toFixed(2)}`).join(' ');

  // Area between the future curve and the baseline level (filled, then split by
  // a horizontal clip into green below / amber above the baseline).
  const divergePath = useMemo(() => {
    if (futurePts.length < 2) return '';
    const top = futurePts
      .map((p) => `L${x(p.i).toFixed(2)},${yG(p.s.gco2).toFixed(2)}`)
      .join(' ');
    const x0 = x(futurePts[0].i).toFixed(2);
    const xN = x(futurePts[futurePts.length - 1].i).toFixed(2);
    return `M${x0},${baselineY.toFixed(2)} ${top.slice(1)} L${xN},${baselineY.toFixed(2)} Z`;
  }, [futurePts, x, yG, baselineY]);

  // Per-slot total demand (MW), carry-filled across gaps (the day-ahead forecast
  // doesn't reach the full 48h; the past tail uses settled generation). Falls
  // back to a normalised 100% scale when no demand is available.
  const mixScale = useMemo(() => {
    const raw = visible.map((v) => v.s.genMw);
    const hasDemand = raw.some((d) => d != null);
    let totals: number[];
    if (hasDemand) {
      totals = raw.slice() as number[];
      let last: number | undefined;
      for (let i = 0; i < totals.length; i++) totals[i] = totals[i] != null ? (last = totals[i]) : (last as number);
      let next: number | undefined;
      for (let i = totals.length - 1; i >= 0; i--) totals[i] = totals[i] != null ? (next = totals[i]) : (next as number);
    } else {
      totals = visible.map(() => 100);
    }
    const maxScale = Math.max(1, ...totals);
    const yMix = (val: number) => PLOT_BOTTOM - (val / maxScale) * PLOT_H;
    return { totals, maxScale, hasDemand, yMix };
  }, [visible]);

  // Stacked-area polygons for mix mode, scaled so the top follows demand.
  const stacks = useMemo(() => {
    if (mode !== 'mix') return [];
    const { totals, yMix } = mixScale;
    return STACK_ORDER.map((fuel) => {
      let pathTop = '';
      let pathBottom = '';
      visible.forEach((p, k) => {
        const total = totals[k];
        let below = 0;
        for (const f of STACK_ORDER) {
          if (f === fuel) break;
          below += (p.s.mix[f] / 100) * total;
        }
        const top = below + (p.s.mix[fuel] / 100) * total;
        const px = x(p.i).toFixed(2);
        pathTop += `${k === 0 ? 'M' : 'L'}${px},${yMix(top).toFixed(2)} `;
        pathBottom = `L${px},${yMix(below).toFixed(2)} ` + pathBottom;
      });
      return { fuel, d: pathTop + pathBottom + 'Z', color: FUEL_META[fuel].color };
    });
  }, [mode, visible, x, mixScale]);

  // x-axis time ticks roughly every 6h.
  const ticks = useMemo(() => {
    const step = Math.max(1, Math.round(visible.length / 5));
    return visible.filter((_, k) => k % step === 0);
  }, [visible]);

  // y-axis ticks: gCO₂ in change mode; demand in GW in mix mode.
  const yTicks = useMemo(() => {
    if (mode === 'mix') {
      if (!mixScale.hasDemand) return [] as { y: number; label: string }[];
      const step = niceStep(mixScale.maxScale / 4);
      const out: { y: number; label: string }[] = [];
      for (let v = 0; v <= mixScale.maxScale && out.length < 8; v += step) {
        out.push({ y: mixScale.yMix(v), label: `${Math.round(v / 1000)}` });
      }
      return out;
    }
    const step = niceStep(layout.gMax / 5);
    const out: { y: number; label: string }[] = [];
    for (let v = 0; v <= layout.gMax && out.length < 16; v += step) out.push({ y: yG(v), label: `${v}` });
    return out;
  }, [mode, layout.gMax, yG, mixScale]);

  // Octopus Agile price overlay on a right-hand axis (p/kWh). Allows negatives
  // (plunge pricing). The line stops where rates end (~24h ahead).
  const price = useMemo(() => {
    if (!prices) return null;
    const pts = visible
      .map((v) => ({ i: v.i, p: prices.get(v.s.ts.slice(0, 16)) }))
      .filter((v): v is { i: number; p: number } => v.p != null);
    if (pts.length < 2) return null;
    const vals = pts.map((p) => p.p);
    const pMin = Math.min(0, ...vals);
    const pMax = Math.max(...vals) * 1.1;
    const yPrice = (p: number) => PLOT_BOTTOM - ((p - pMin) / Math.max(1, pMax - pMin)) * PLOT_H;
    const path = pts
      .map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(2)},${yPrice(p.p).toFixed(2)}`)
      .join(' ');
    const step = niceStep((pMax - pMin) / 4);
    const ticks: { y: number; label: string }[] = [];
    for (let v = Math.ceil(pMin / step) * step; v <= pMax && ticks.length < 16; v += step) {
      ticks.push({ y: yPrice(v), label: `${Math.round(v)}p` });
    }
    return { path, ticks, lastX: x(pts[pts.length - 1].i) };
  }, [prices, visible, x]);

  function handlePointer(e: ReactPointerEvent<SVGSVGElement>, gate: boolean) {
    if (gate && !pressed.current && e.pointerType !== 'mouse') return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    // Nearest visible slot.
    let best = visible[0];
    let bestDist = Infinity;
    for (const v of visible) {
      const d = Math.abs(x(v.i) - px);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    if (best) onScrub(best.i);
  }

  const cursor = cursorIndex != null ? visible.find((v) => v.i === cursorIndex) : undefined;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Carbon intensity forecast over the next hours"
      onPointerDown={(e) => {
        pressed.current = true;
        svgRef.current?.setPointerCapture(e.pointerId);
        handlePointer(e, false);
      }}
      onPointerMove={(e) => handlePointer(e, true)}
      onPointerUp={(e) => {
        pressed.current = false;
        svgRef.current?.releasePointerCapture(e.pointerId);
        onScrub(null);
      }}
      onPointerLeave={() => {
        if (!pressed.current) onScrub(null);
      }}
    >
      <defs>
        {/* Continuous diverging fill: deep green far below the baseline →
            neutral at it → deep brown far above. Keyed to the baseline's y. */}
        <linearGradient
          id="diverge"
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={PAD.top}
          x2={0}
          y2={PLOT_BOTTOM}
        >
          <stop offset={0} stopColor="#ef4444" stopOpacity={0.85} />
          <stop offset={topFrac} stopColor="#ef4444" stopOpacity={0.85} />
          <stop offset={baseFrac} stopColor="#eab308" stopOpacity={0.8} />
          <stop offset={botFrac} stopColor="#22c55e" stopOpacity={0.85} />
          <stop offset={1} stopColor="#22c55e" stopOpacity={0.85} />
        </linearGradient>
      </defs>

      {/* y-axis: gridlines + labels (gCO₂ in change mode, share % in mix mode) */}
      {yTicks.map((t, k) => (
        <g key={`y${k}`}>
          <line
            x1={PAD.left}
            y1={t.y}
            x2={W - PAD.right}
            y2={t.y}
            stroke="var(--border)"
            strokeWidth={0.5}
          />
          <text x={PAD.left - 5} y={t.y + 3} textAnchor="end" fontSize={8.5} fill="var(--text-faint)">
            {t.label}
          </text>
        </g>
      ))}
      {mode === 'change' && (
        <text x={2} y={PAD.top - 7} textAnchor="start" fontSize={8.5} fill="var(--text-dim)">
          gCO₂/kWh
        </text>
      )}
      {mode === 'mix' && mixScale.hasDemand && (
        <text x={2} y={PAD.top - 7} textAnchor="start" fontSize={8.5} fill="var(--text-dim)">
          GW gen
        </text>
      )}

      {mode === 'change' && (
        <>
          <path d={divergePath} fill="url(#diverge)" />
          {/* horizontal baseline emanating from the now dot */}
          <line
            x1={nowX}
            y1={baselineY}
            x2={W - PAD.right}
            y2={baselineY}
            stroke="var(--text-faint)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        </>
      )}

      {mode === 'mix' &&
        stacks.map((st) => (
          <path key={st.fuel} d={st.d} fill={st.color} opacity={0.85} />
        ))}

      {/* past tail: muted + dashed */}
      <path
        d={linePath(pastPts)}
        fill="none"
        stroke="var(--text-faint)"
        strokeWidth={1.5}
        strokeDasharray="3 3"
      />
      {/* future intensity: solid, muted grey to match the dashed history */}
      <path d={linePath(futurePts)} fill="none" stroke="var(--text-faint)" strokeWidth={1.5} />

      {/* Agile price overlay (right axis), distinct colour so it reads as cost, not carbon */}
      {price && (
        <>
          <path d={price.path} fill="none" stroke="var(--price)" strokeWidth={1.25} />
          {price.ticks.map((t, k) => (
            <text
              key={`p${k}`}
              x={W - PAD.right + 5}
              y={t.y + 3}
              textAnchor="start"
              fontSize={8.5}
              fill="var(--price)"
            >
              {t.label}
            </text>
          ))}
          <text
            x={W - PAD.right + 5}
            y={PAD.top - 7}
            textAnchor="start"
            fontSize={7.5}
            fill="var(--price)"
          >
            p/kWh
          </text>
        </>
      )}

      {/* now anchor: vertical divider */}
      <line
        x1={nowX}
        y1={PAD.top - 4}
        x2={nowX}
        y2={PLOT_BOTTOM}
        stroke="var(--now)"
        strokeWidth={1}
        opacity={0.5}
      />
      {/* now pill */}
      <g transform={`translate(${nowX}, ${PAD.top - 10})`}>
        <rect x={-16} y={-9} width={32} height={15} rx={7.5} fill="var(--now)" />
        <text x={0} y={1.5} textAnchor="middle" fontSize={9} fontWeight={700} fill="#0d1117">
          Now
        </text>
      </g>
      {/* now dot */}
      <circle cx={nowX} cy={nowY} r={3.5} fill="var(--now)" />

      {/* scrub guide */}
      {cursor && (
        <>
          <line
            x1={x(cursor.i)}
            y1={PAD.top}
            x2={x(cursor.i)}
            y2={PLOT_BOTTOM}
            stroke="var(--accent)"
            strokeWidth={1}
          />
          <circle cx={x(cursor.i)} cy={yG(cursor.s.gco2)} r={3.5} fill="var(--accent)" />
        </>
      )}

      {/* x-axis time labels; edge labels anchor inward so they don't clip */}
      {ticks.map((t, k) => {
        const tx = x(t.i);
        const anchor = tx <= PAD.left + 6 ? 'start' : tx >= W - PAD.right - 6 ? 'end' : 'middle';
        return (
          <text
            key={k}
            x={tx}
            y={H - 8}
            textAnchor={anchor}
            fontSize={8.5}
            fill="var(--text-faint)"
          >
            {fmtTime(t.s.ts)}
          </text>
        );
      })}
    </svg>
  );
}
