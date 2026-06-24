// Assemble the normalised `Series` (SPEC §3): a recent actual tail concatenated
// with the 48h forward forecast, with `nowIndex` marking the boundary.
//
// Intensity comes from the national fw48h endpoint (authoritative actuals +
// forecast). The forward generation mix comes from the GB regional forecast,
// the only public source of a forward mix; the past tail's mix comes from the
// national generation-range endpoint (true settled shares). For a DNO region,
// the regional forecast supplies both intensity and mix.

import {
  getNationalForward,
  getIntensityRange,
  getGenerationRange,
  getRegionalForward,
  getRegionalRange,
  toApiTime,
} from '../api/carbon';
import type { IntensityPoint, MixPoint, RegionalForecastPoint } from '../api/carbon';
import { getDemandForecast, getTotalGenerationMW } from '../api/elexon';
import {
  FUELS,
  NATIONAL,
  SLOT_MINUTES,
  type Fuel,
  type FuelMix,
  type RegionSelection,
  type Series,
  type Slot,
} from './types';

const SLOT_MS = SLOT_MINUTES * 60 * 1000;
const TAIL_HOURS = 12;

function floorToSlot(d: Date): Date {
  const ms = d.getTime();
  return new Date(ms - (ms % SLOT_MS));
}

function fullMix(partial: Partial<FuelMix> | undefined): FuelMix {
  const out = {} as FuelMix;
  for (const f of FUELS) out[f] = partial?.[f] ?? 0;
  return out;
}

function emptyMix(): FuelMix {
  return fullMix(undefined);
}

// Total national demand (MW) per half-hour over the visible window: settled
// generation (Elexon FUELHH) for the past tail + the day-ahead demand forecast
// for the future. Used to scale the energy-mix stack to the varying demand.
async function loadDemand(
  tailFrom: Date,
  slotNow: Date,
  horizonEnd: Date,
): Promise<Map<string, number>> {
  const [past, future] = await Promise.all([
    getTotalGenerationMW(tailFrom, slotNow).catch(() => new Map<string, number>()),
    getDemandForecast(slotNow, horizonEnd).catch(() => new Map<string, number>()),
  ]);
  const m = new Map(past);
  for (const [k, v] of future) m.set(k, v);
  return m;
}

function attachDemand(slots: Slot[], demand: Map<string, number>): void {
  for (const s of slots) {
    const d = demand.get(s.ts.slice(0, 16));
    if (d != null) s.demandMw = d;
  }
}

type Baseload = { hydro: number; other: number };

function minuteKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

const WEEK_MS = 7 * 864e5;

/**
 * NESO's regional forecast omits hydro and "other" (they come back as 0 while
 * the remaining fuels are renormalised to 100%, inflating gas/wind by ~7%).
 * Both are stable baseload with time-of-day patterns, so we predict each
 * forecast slot's hydro/other from the *actual* shares at the same time exactly
 * a week earlier, and scale the rest down to make room. Where a week-ago slot
 * is missing we fall back to the recent-actual average. A disclosed estimate,
 * not NESO forecast data.
 */
function fillForecastBaseload(
  slots: Slot[],
  nowIndex: number,
  weekAgo: Map<string, Baseload>,
): void {
  const recent = slots.slice(0, nowIndex).filter((s) => s.kind === 'actual').slice(-6);
  const fbAvg = (f: Fuel) =>
    recent.length ? recent.reduce((a, s) => a + s.mix[f], 0) / recent.length : 0;
  const fallback: Baseload = { hydro: fbAvg('hydro'), other: fbAvg('other') };

  const rest = FUELS.filter((f) => f !== 'hydro' && f !== 'other');
  for (let i = nowIndex; i < slots.length; i++) {
    const s = slots[i];
    if (s.kind !== 'forecast' || s.mix.hydro > 0 || s.mix.other > 0) continue;
    const ref = weekAgo.get(minuteKey(Date.parse(s.ts) - WEEK_MS)) ?? fallback;
    if (ref.hydro + ref.other <= 0) continue;
    const restSum = rest.reduce((a, f) => a + s.mix[f], 0);
    const scale = restSum > 0 ? Math.max(0, 100 - ref.hydro - ref.other) / restSum : 0;
    for (const f of rest) s.mix[f] = s.mix[f] * scale;
    s.mix.hydro = ref.hydro;
    s.mix.other = ref.other;
  }
}

/** Merge intensity points with a timestamp->mix lookup into ordered slots. */
function assemble(
  intensity: IntensityPoint[],
  mixByTs: Map<string, Partial<FuelMix>>,
): Slot[] {
  return intensity
    .filter((p) => p.forecast != null || p.actual != null)
    .map((p) => {
      const gco2 = p.actual ?? p.forecast ?? 0;
      return {
        ts: p.from,
        kind: p.actual != null ? 'actual' : 'forecast',
        gco2,
        index: p.index,
        mix: fullMix(mixByTs.get(p.from)),
      } satisfies Slot;
    });
}

/** Index of the slot covering `now` (or the last actual if now is past the data). */
function findNowIndex(slots: Slot[], now: Date): number {
  const nowMs = now.getTime();
  for (let i = 0; i < slots.length; i++) {
    const start = Date.parse(slots[i].ts);
    if (nowMs >= start && nowMs < start + SLOT_MS) return i;
  }
  // Fall back to the boundary between actual and forecast.
  const firstForecast = slots.findIndex((s) => s.kind === 'forecast');
  if (firstForecast > 0) return firstForecast - 1;
  return firstForecast === 0 ? 0 : Math.max(0, slots.length - 1);
}

function mixLookup(...sources: Array<Array<{ from: string; mix: Partial<FuelMix> }>>) {
  const map = new Map<string, Partial<FuelMix>>();
  for (const src of sources) {
    for (const p of src) map.set(p.from, p.mix);
  }
  return map;
}

export async function buildNationalSeries(now = new Date()): Promise<Series> {
  const tailFrom = floorToSlot(new Date(now.getTime() - TAIL_HOURS * 3600 * 1000));
  const slotNow = floorToSlot(now);

  // Week-ago actual generation, to predict the hydro/other the forecast omits.
  const weekFrom = new Date(slotNow.getTime() - WEEK_MS);
  const weekTo = new Date(weekFrom.getTime() + 50 * 3600 * 1000); // covers the 48h horizon

  const horizonEnd = new Date(slotNow.getTime() + 48 * 3600 * 1000);

  // `fw48h` is anchored at its start time, so the past tail is fetched as an
  // explicit range and the forward 48h forecast separately, then concatenated.
  const [tail, forward, pastMix, forwardMix, weekAgoMix, demand] = await Promise.all([
    getIntensityRange(tailFrom, slotNow),
    getNationalForward(slotNow),
    getGenerationRange(tailFrom, slotNow).catch(() => [] as MixPoint[]),
    getRegionalForward(slotNow, NATIONAL.regionId).catch(() => [] as RegionalForecastPoint[]),
    getGenerationRange(weekFrom, weekTo).catch(() => [] as MixPoint[]),
    loadDemand(tailFrom, slotNow, horizonEnd),
  ]);

  const weekAgo = new Map<string, Baseload>();
  for (const p of weekAgoMix) {
    weekAgo.set(p.from.slice(0, 16), { hydro: p.mix.hydro ?? 0, other: p.mix.other ?? 0 });
  }

  // Dedupe intensity by timestamp; the forward forecast wins at the boundary.
  const intensityByTs = new Map<string, IntensityPoint>();
  for (const p of tail) intensityByTs.set(p.from, p);
  for (const p of forward) intensityByTs.set(p.from, p);
  const intensity = [...intensityByTs.values()].sort((a, b) => a.from.localeCompare(b.from));

  // Forward mix (regional GB) wins for forecast slots; past actual mix fills the tail.
  const mixByTs = mixLookup(pastMix, forwardMix);
  const slots = assemble(intensity, mixByTs);
  const nowIndex = findNowIndex(slots, now);
  fillForecastBaseload(slots, nowIndex, weekAgo);
  attachDemand(slots, demand);
  return {
    slots,
    nowIndex,
    region: NATIONAL,
    generatedAt: now.toISOString(),
  };
}

export async function buildRegionalSeries(
  region: RegionSelection,
  now = new Date(),
): Promise<Series> {
  if (region.regionId === NATIONAL.regionId) return buildNationalSeries(now);

  const slotNow = floorToSlot(now);
  const tailFrom = floorToSlot(new Date(now.getTime() - TAIL_HOURS * 3600 * 1000));

  // Regional has no settled actuals, so both the tail and forward are NESO's
  // regional estimate. The tail still gives the dashed history context. Demand is
  // national-only, so it isn't applied here — the regional mix stays a normalised
  // 100% stack rather than being scaled to a mismatched demand curve.
  const [tail, forward] = await Promise.all([
    getRegionalRange(tailFrom, slotNow, region.regionId).catch(() => [] as RegionalForecastPoint[]),
    getRegionalForward(slotNow, region.regionId),
  ]);

  const byTs = new Map<string, RegionalForecastPoint>();
  for (const p of tail) byTs.set(p.from, p);
  for (const p of forward) byTs.set(p.from, p); // forward wins at the boundary
  const points = [...byTs.values()]
    .filter((p) => p.forecast != null)
    .sort((a, b) => a.from.localeCompare(b.from));

  const slotNowMs = slotNow.getTime();
  const slots = points.map(
    (p): Slot => ({
      ts: p.from,
      // Past half-hours render as the dashed tail (regional estimate, not metered).
      kind: Date.parse(p.from) < slotNowMs ? 'actual' : 'forecast',
      gco2: p.forecast ?? 0,
      index: p.index,
      mix: fullMix(p.mix),
    }),
  );
  return {
    slots,
    nowIndex: findNowIndex(slots, now),
    region,
    generatedAt: now.toISOString(),
  };
}

export { emptyMix, floorToSlot, fullMix, toApiTime };
