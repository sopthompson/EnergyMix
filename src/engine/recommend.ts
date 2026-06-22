// Recommendation engine (SPEC §4). Pure functions over a `Series` with no UI
// dependency: relative framing, a duration-aware window finder, window
// classification, per-source deltas, and grounded messaging. The app is not a
// forecaster — this is the decision layer on top of NESO's forecast.

import { FUEL_META, helpSign } from '../model/fuels';
import {
  FUELS,
  SLOTS_PER_HOUR,
  type Fuel,
  type FuelMix,
  type MonthlyAverage,
  type Series,
  type Slot,
} from '../model/types';

export type Baseline = 'now' | 'average';

export interface LoadPreset {
  id: string;
  label: string;
  slots: number; // duration in half-hour slots
}

// SPEC §4.2 presets.
export const LOAD_PRESETS: LoadPreset[] = [
  { id: 'dishwasher', label: 'Dishwasher', slots: 3 }, // ~1.5h
  { id: 'washing', label: 'Washing machine', slots: 4 }, // ~2h
  { id: 'ev', label: 'EV charge', slots: 10 }, // ~5h (4–6h band)
];

// ---------- helpers ----------

export function nowSlot(series: Series): Slot {
  return series.slots[series.nowIndex];
}

/** Forward slots from `now` (inclusive) within an optional horizon in hours. */
export function forwardSlots(series: Series, horizonHours = 24): Slot[] {
  const start = series.slots[series.nowIndex];
  if (!start) return [];
  const startMs = Date.parse(start.ts);
  const limitMs = startMs + horizonHours * 3600 * 1000;
  return series.slots
    .slice(series.nowIndex)
    .filter((s) => Date.parse(s.ts) < limitMs);
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Linear-interpolated quantile (q in 0..1) of an unsorted numeric array. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- §4.1 relative framing ----------

/** (slot.gco2 - now.gco2) / now.gco2 — signed fraction vs the current moment. */
export function deltaVsNow(series: Series, slot: Slot): number {
  const now = nowSlot(series);
  if (!now || now.gco2 === 0) return 0;
  return (slot.gco2 - now.gco2) / now.gco2;
}

/** Signed fraction of a value vs an arbitrary reference level. */
export function deltaVsValue(gco2: number, ref: number): number {
  return ref > 0 ? (gco2 - ref) / ref : 0;
}

/**
 * Rank of a slot within the forward window (default next 24h), 0..1 where 0 is
 * the cleanest. Lets the UI say "cleanest 10% of today" honestly across seasons.
 */
export function percentileToday(series: Series, slot: Slot, horizonHours = 24): number {
  const values = forwardSlots(series, horizonHours).map((s) => s.gco2);
  if (!values.length) return 0;
  const below = values.filter((v) => v < slot.gco2).length;
  const equal = values.filter((v) => v === slot.gco2).length;
  return (below + equal / 2) / values.length;
}

/**
 * Baseline level a fill/judgement measures against (SPEC §4.1, §5.1). "average"
 * uses the demand-weighted 30-day figure when available, else falls back to the
 * forward-window mean.
 */
export function baselineValue(
  series: Series,
  baseline: Baseline,
  monthlyAvg?: MonthlyAverage | null,
  horizonHours = 24,
): number {
  if (baseline === 'now') return nowSlot(series)?.gco2 ?? 0;
  if (monthlyAvg) return monthlyAvg.gco2;
  return mean(forwardSlots(series, horizonHours).map((s) => s.gco2));
}

// ---------- §4.2 duration-aware window finder ----------

export interface WindowOpts {
  earliestStart?: Date;
  deadline?: Date; // window must finish on or before this
  horizonHours?: number; // cap the search horizon (default 48)
}

export interface WindowResult {
  startIndex: number; // absolute index into series.slots
  endIndex: number; // inclusive
  startTs: string;
  endTs: string; // end of the last slot
  totalGco2: number; // integrated sum over the D slots
  meanGco2: number;
  runNowGco2: number; // integrated carbon of starting immediately
  savingVsNow: number; // fraction saved vs running now (>0 means cleaner)
}

interface Candidate {
  startIndex: number;
  total: number;
}

/** Forward, in-bounds candidate start indices for a width-D window. */
function eligibleStarts(series: Series, durationSlots: number, opts: WindowOpts): number[] {
  const horizon = opts.horizonHours ?? 48;
  const window = forwardSlots(series, horizon);
  if (window.length < durationSlots) return [];

  const earliest = opts.earliestStart?.getTime() ?? -Infinity;
  const deadline = opts.deadline?.getTime() ?? Infinity;
  const slotMs = (3600 * 1000) / SLOTS_PER_HOUR;

  const starts: number[] = [];
  const baseIndex = series.nowIndex;
  for (let i = 0; i + durationSlots <= window.length; i++) {
    const startTsMs = Date.parse(window[i].ts);
    const endTsMs = Date.parse(window[i + durationSlots - 1].ts) + slotMs;
    if (startTsMs >= earliest && endTsMs <= deadline) starts.push(baseIndex + i);
  }
  return starts;
}

function buildResult(series: Series, startIndex: number, durationSlots: number): WindowResult {
  const slotMs = (3600 * 1000) / SLOTS_PER_HOUR;
  const slice = series.slots.slice(startIndex, startIndex + durationSlots);
  const total = slice.reduce((a, s) => a + s.gco2, 0);
  const runNowSlice = series.slots.slice(series.nowIndex, series.nowIndex + durationSlots);
  const runNow = runNowSlice.reduce((a, s) => a + s.gco2, 0);
  return {
    startIndex,
    endIndex: startIndex + durationSlots - 1,
    startTs: slice[0].ts,
    endTs: new Date(Date.parse(slice[slice.length - 1].ts) + slotMs).toISOString(),
    totalGco2: total,
    meanGco2: total / durationSlots,
    runNowGco2: runNow,
    savingVsNow: runNow === 0 ? 0 : (runNow - total) / runNow,
  };
}

/** O(n) sliding-sum search for the cleanest width-D window. */
export function findBestWindow(
  series: Series,
  durationSlots: number,
  opts: WindowOpts = {},
): WindowResult | null {
  const candidates = scoredCandidates(series, durationSlots, opts);
  if (!candidates.length) return null;
  const best = candidates.reduce((a, b) => (b.total < a.total ? b : a));
  return buildResult(series, best.startIndex, durationSlots);
}

function scoredCandidates(
  series: Series,
  durationSlots: number,
  opts: WindowOpts,
): Candidate[] {
  const starts = eligibleStarts(series, durationSlots, opts);
  if (!starts.length) return [];
  // Sliding sum over the contiguous forward block.
  const out: Candidate[] = [];
  let running = 0;
  let windowStart = starts[0];
  for (let k = 0; k < durationSlots; k++) running += series.slots[windowStart + k].gco2;
  const startSet = new Set(starts);
  if (startSet.has(windowStart)) out.push({ startIndex: windowStart, total: running });

  const lastStart = starts[starts.length - 1];
  for (let s = windowStart + 1; s <= lastStart; s++) {
    running += series.slots[s + durationSlots - 1].gco2 - series.slots[s - 1].gco2;
    if (startSet.has(s)) out.push({ startIndex: s, total: running });
  }
  return out;
}

// Default "best window" span: the cleanest 2h block (4 half-hour slots).
export const BEST_WINDOW_SLOTS = 4;

/**
 * One best window per calendar day across the horizon. Each day is searched
 * independently for its lowest-average width-D block, so a day that is uniformly
 * dirty still yields its own (less-good) best, and a genuinely cleaner block on a
 * later day is surfaced rather than hidden behind the next 24h.
 */
export function findDailyBestWindows(
  series: Series,
  durationSlots = BEST_WINDOW_SLOTS,
  horizonHours = 48,
): WindowResult[] {
  const fwd = forwardSlots(series, horizonHours);
  if (!fwd.length) return [];
  const slotMs = (3600 * 1000) / SLOTS_PER_HOUR;
  const dayOf = (ts: string) => new Date(ts).toLocaleDateString('en-GB');

  const days: string[] = [];
  const seen = new Set<string>();
  for (const s of fwd) {
    const key = dayOf(s.ts);
    if (!seen.has(key)) {
      seen.add(key);
      days.push(key);
    }
  }

  const out: WindowResult[] = [];
  for (const key of days) {
    const daySlots = fwd.filter((s) => dayOf(s.ts) === key);
    if (daySlots.length < durationSlots) continue;
    const earliestStart = new Date(daySlots[0].ts);
    const deadline = new Date(Date.parse(daySlots[daySlots.length - 1].ts) + slotMs);
    const best = findBestWindow(series, durationSlots, { earliestStart, deadline, horizonHours });
    if (best) out.push(best);
  }
  return out;
}

/**
 * The cleanest width-D window within *tomorrow* — the next complete local
 * calendar day. Unlike "today" (which shrinks as the day passes) or the day-2
 * edge of the 48h forecast (which is only partially covered), tomorrow is always
 * fully forecast, so this recommendation stays stable across refreshes.
 */
export function findNextDayBestWindow(
  series: Series,
  durationSlots = BEST_WINDOW_SLOTS,
): WindowResult | null {
  const fwd = forwardSlots(series, 48);
  if (!fwd.length) return null;
  const slotMs = (3600 * 1000) / SLOTS_PER_HOUR;
  const dayOf = (ts: string) => new Date(ts).toLocaleDateString('en-GB');

  const todayKey = dayOf(fwd[0].ts);
  const tomorrow = fwd.find((s) => dayOf(s.ts) !== todayKey);
  if (!tomorrow) return null;
  const tomorrowKey = dayOf(tomorrow.ts);
  const daySlots = fwd.filter((s) => dayOf(s.ts) === tomorrowKey);
  if (daySlots.length < durationSlots) return null;

  const earliestStart = new Date(daySlots[0].ts);
  const deadline = new Date(Date.parse(daySlots[daySlots.length - 1].ts) + slotMs);
  return findBestWindow(series, durationSlots, { earliestStart, deadline, horizonHours: 48 });
}

/** Top-k non-overlapping cleanest windows, greedy by integrated carbon. */
export function findTopWindows(
  series: Series,
  durationSlots: number,
  k: number,
  opts: WindowOpts = {},
): WindowResult[] {
  const candidates = scoredCandidates(series, durationSlots, opts).sort(
    (a, b) => a.total - b.total,
  );
  const chosen: WindowResult[] = [];
  const used: Array<[number, number]> = [];
  for (const c of candidates) {
    if (chosen.length >= k) break;
    const end = c.startIndex + durationSlots - 1;
    const overlaps = used.some(([s, e]) => c.startIndex <= e && end >= s);
    if (overlaps) continue;
    used.push([c.startIndex, end]);
    chosen.push(buildResult(series, c.startIndex, durationSlots));
  }
  return chosen.sort((a, b) => a.startIndex - b.startIndex);
}

// ---------- §4.3 window classification (the "cuts") ----------

export interface ClassifiedWindow {
  kind: 'recommended' | 'avoid';
  startIndex: number;
  endIndex: number;
  startTs: string;
  endTs: string;
  meanGco2: number;
  deltaVsNow: number;
  dominantFuels: Fuel[];
  suggestedLoads: string[];
}

export interface ClassifyOpts {
  horizonHours?: number;
  minSlots?: number; // minimum run length (default 2 == 1h)
}

/** Dominant fuels in a slice by mean share, top `n`. */
export function dominantFuels(slots: Slot[], n = 2): Fuel[] {
  const totals = {} as Record<Fuel, number>;
  for (const f of FUELS) totals[f] = 0;
  for (const s of slots) for (const f of FUELS) totals[f] += s.mix[f];
  return FUELS.slice()
    .sort((a, b) => totals[b] - totals[a])
    .slice(0, n);
}

function suggestedLoads(durationSlots: number): string[] {
  return LOAD_PRESETS.filter((p) => p.slots <= durationSlots).map((p) => p.label);
}

/**
 * Contiguous forward runs below the 25th percentile (recommended) or above the
 * 75th (avoid), each at least `minSlots` long.
 */
export function classifyWindows(series: Series, opts: ClassifyOpts = {}): ClassifiedWindow[] {
  const horizon = opts.horizonHours ?? 24;
  const minSlots = opts.minSlots ?? 2;
  const window = forwardSlots(series, horizon);
  if (window.length < minSlots) return [];

  const values = window.map((s) => s.gco2);
  const p25 = quantile(values, 0.25);
  const p75 = quantile(values, 0.75);
  const slotMs = (3600 * 1000) / SLOTS_PER_HOUR;

  const out: ClassifiedWindow[] = [];
  let runStart = -1;
  let runKind: 'recommended' | 'avoid' | null = null;

  const flush = (endLocal: number) => {
    if (runStart < 0 || runKind === null) return;
    const len = endLocal - runStart + 1;
    if (len < minSlots) return;
    const slice = window.slice(runStart, endLocal + 1);
    const startIndex = series.nowIndex + runStart;
    out.push({
      kind: runKind,
      startIndex,
      endIndex: startIndex + len - 1,
      startTs: slice[0].ts,
      endTs: new Date(Date.parse(slice[slice.length - 1].ts) + slotMs).toISOString(),
      meanGco2: mean(slice.map((s) => s.gco2)),
      deltaVsNow: deltaVsNow(series, slice[0]),
      dominantFuels: dominantFuels(slice),
      suggestedLoads: suggestedLoads(len),
    });
  };

  for (let i = 0; i < window.length; i++) {
    const v = window[i].gco2;
    const kind: 'recommended' | 'avoid' | null =
      v <= p25 ? 'recommended' : v >= p75 ? 'avoid' : null;
    if (kind !== runKind) {
      flush(i - 1);
      runStart = kind ? i : -1;
      runKind = kind;
    }
  }
  flush(window.length - 1);
  return out;
}

// ---------- §4.4 per-source delta vs now ----------

export interface SourceDelta {
  fuel: Fuel;
  refShare: number; // reference share (now, or 30-day average)
  slotShare: number;
  deltaPp: number; // percentage points, slot - reference
  helps: boolean; // does this shift help carbon?
  helpful: number; // signed by carbon direction: + good, - bad, 0 neutral
}

/**
 * Per-fuel mix delta of a slot vs a reference (the current mix by default, or a
 * supplied average mix), with carbon-direction colouring info.
 */
export function perSourceDelta(series: Series, slot: Slot, referenceMix?: FuelMix): SourceDelta[] {
  const ref = referenceMix ?? nowSlot(series)?.mix;
  return FUELS.map((fuel) => {
    const refShare = ref?.[fuel] ?? 0;
    const slotShare = slot.mix[fuel];
    const deltaPp = slotShare - refShare;
    const helpful = deltaPp * helpSign(fuel) || 0; // normalise -0 to 0
    return { fuel, refShare, slotShare, deltaPp, helps: helpful > 0, helpful };
  });
}

// ---------- §4.5 messaging ----------

export interface GroundedMessage {
  text: string;
  figure: string; // the number the claim is bound to
  tone: 'good' | 'bad' | 'neutral';
}

/** A grounded one-liner for the current state, bound to a real figure. */
export function headlineMessage(
  series: Series,
  baseline: Baseline,
  monthlyAvg?: MonthlyAverage | null,
  horizonHours = 24,
): GroundedMessage {
  const now = nowSlot(series);
  const top = dominantFuels(forwardSlots(series, 1), 1)[0];
  const topShare = Math.round(now.mix[top] ?? 0);
  const best = findBestWindow(series, BEST_WINDOW_SLOTS, { horizonHours });

  if (baseline === 'average') {
    const ref =
      monthlyAvg?.gco2 ?? mean(forwardSlots(series, horizonHours).map((s) => s.gco2));
    const nowD = Math.round(deltaVsValue(now.gco2, ref) * 100);
    const bestD = best ? Math.round(deltaVsValue(best.meanGco2, ref) * 100) : nowD;
    const figAvg = `${Math.round(now.gco2)} vs ${Math.round(ref)} gCO₂/kWh avg`;

    // Now is already cleaner than a typical recent half-hour.
    if (nowD <= -5) {
      return {
        text: `Now is ${Math.abs(nowD)}% below the 30-day average — a good time to use power.`,
        figure: figAvg,
        tone: 'good',
      };
    }
    // A window dips below the average later; point to it.
    if (best && bestD <= -5) {
      return {
        text: `${nowD > 0 ? `Now is ${nowD}% above average.` : 'Now is around average.'} Cleanest ${formatDayTime(new Date(best.startTs))}–${formatTime(new Date(best.endTs))}, ${Math.abs(bestD)}% below average.`,
        figure: figAvg,
        tone: 'neutral',
      };
    }
    // Nothing in the horizon beats the average; still name the least-carbon window.
    if (best) {
      const sign = bestD >= 0 ? `+${bestD}` : `${bestD}`;
      const lead =
        nowD >= 5
          ? `Above the 30-day average all of the next ${horizonHours}h.`
          : `Around the 30-day average for the next ${horizonHours}h.`;
      return {
        text: `${lead} Best window ${formatDayTime(new Date(best.startTs))}–${formatTime(new Date(best.endTs))} (${sign}% vs avg).`,
        figure: figAvg,
        tone: nowD >= 5 ? 'bad' : 'neutral',
      };
    }
    return {
      text: `Around the 30-day average for the next ${horizonHours}h.`,
      figure: figAvg,
      tone: 'neutral',
    };
  }

  // baseline === 'now': name a meaningfully cleaner window with its day + time.
  const saving = best && now.gco2 > 0 ? Math.round((1 - best.meanGco2 / now.gco2) * 100) : 0;
  if (best && saving >= 5) {
    return {
      text: `Best time ${formatDayTime(new Date(best.startTs))}–${formatTime(new Date(best.endTs))} — about ${saving}% lower than now.`,
      figure: `now ${Math.round(now.gco2)} → ${Math.round(best.meanGco2)} gCO₂/kWh`,
      tone: 'good',
    };
  }
  return {
    text: `Now is about as good as any time in the next ${horizonHours}h.`,
    figure: `${Math.round(now.gco2)} gCO₂/kWh · ${FUEL_META[top].label.toLowerCase()} ${topShare}%`,
    tone: 'good',
  };
}

/** A grounded one-liner describing a specific slot relative to now. */
export function slotMessage(series: Series, slot: Slot): GroundedMessage {
  const d = deltaVsNow(series, slot);
  const top = dominantFuels([slot], 1)[0];
  const topShare = Math.round(slot.mix[top]);
  if (d <= -0.05) {
    return {
      text: `Cleaner than now: ${FUEL_META[top].label.toLowerCase()} ~${topShare}% of the grid.`,
      figure: `${Math.round(Math.abs(d) * 100)}% lower · ${Math.round(slot.gco2)} gCO₂/kWh`,
      tone: 'good',
    };
  }
  if (d >= 0.05) {
    return {
      text: `Dirtier than now — ${FUEL_META[top].label.toLowerCase()} dominates at ~${topShare}%.`,
      figure: `${Math.round(d * 100)}% higher · ${Math.round(slot.gco2)} gCO₂/kWh`,
      tone: 'bad',
    };
  }
  return {
    text: `About the same as now.`,
    figure: `${Math.round(slot.gco2)} gCO₂/kWh`,
    tone: 'neutral',
  };
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Weekday + time, e.g. "Mon 14:00" — disambiguates which day across the horizon.
function formatDayTime(d: Date): string {
  const wd = d.toLocaleDateString('en-GB', { weekday: 'short' });
  return `${wd} ${formatTime(d)}`;
}
