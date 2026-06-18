// Compute the demand-weighted 30-day average carbon intensity and the
// generation-weighted average mix (SPEC §4.1), per region. Weighting by
// generation (MW) rather than time makes this a true average gCO₂ per kWh.
//
//   gco2 = Σ(intensity_t × MW_t) / Σ(MW_t)
//   mix  = Σ(share_t × MW_t)     / Σ(MW_t)   per fuel
//
// National (GB) uses settled national actuals + national mix. A DNO region uses
// NESO's regional estimate for intensity and mix. The MW weight is always the
// national demand profile (Elexon FUELHH) — there is no per-region MW feed, and
// demand *timing* is broadly common across GB. Cached 12h per region.

import { getIntensityRange, getGenerationRange, getRegionalRange } from '../api/carbon';
import { getTotalGenerationMW } from '../api/elexon';
import { readCache, writeCache } from '../api/cache';
import {
  FUELS,
  NATIONAL,
  type FuelMix,
  type MonthlyAverage,
  type RegionSelection,
} from './types';

const DAYS = 30;
const CACHE_TTL = 12 * 60 * 60 * 1000;
const REGIONAL_CHUNK_MS = 14 * 864e5;

function tsKey(iso: string): string {
  return iso.slice(0, 16);
}

function emptyMix(): FuelMix {
  const m = {} as FuelMix;
  for (const f of FUELS) m[f] = 0;
  return m;
}

interface MixPointLike {
  from: string;
  mix: Partial<FuelMix>;
}

/** Regional intensity + mix over a month, fetched in ≤14-day chunks. */
async function loadRegionalMonth(from: Date, to: Date, regionId: number) {
  const points = [];
  for (let s = from.getTime(); s < to.getTime(); s += REGIONAL_CHUNK_MS) {
    const e = new Date(Math.min(s + REGIONAL_CHUNK_MS, to.getTime()));
    points.push(...(await getRegionalRange(new Date(s), e, regionId)));
  }
  return points;
}

export async function computeMonthlyAverage(
  region: RegionSelection,
  now = new Date(),
): Promise<MonthlyAverage> {
  const to = now;
  const from = new Date(now.getTime() - DAYS * 864e5);
  const cacheKey = `monthlyAvg:${region.regionId}:${from.toISOString().slice(0, 10)}:${to
    .toISOString()
    .slice(0, 10)}`;

  const cached = readCache<MonthlyAverage>(cacheKey, CACHE_TTL);
  if (cached) return cached;

  // National demand profile is always the weight.
  const mwP = getTotalGenerationMW(from, to);

  const gco2ByTs = new Map<string, number>();
  let genPoints: MixPointLike[];
  let mw: Map<string, number>;

  if (region.regionId === NATIONAL.regionId) {
    const [intensity, generation, mwRes] = await Promise.all([
      getIntensityRange(from, to),
      getGenerationRange(from, to),
      mwP,
    ]);
    for (const p of intensity) {
      const v = p.actual ?? p.forecast;
      if (v != null) gco2ByTs.set(tsKey(p.from), v);
    }
    genPoints = generation;
    mw = mwRes;
  } else {
    const [pts, mwRes] = await Promise.all([
      loadRegionalMonth(from, to, region.regionId),
      mwP,
    ]);
    for (const p of pts) if (p.forecast != null) gco2ByTs.set(tsKey(p.from), p.forecast);
    genPoints = pts;
    mw = mwRes;
  }

  // Demand-weighted intensity.
  let wGco2 = 0;
  let wTotal = 0;
  let samples = 0;
  for (const [ts, weight] of mw) {
    const g = gco2ByTs.get(ts);
    if (g != null && weight > 0) {
      wGco2 += g * weight;
      wTotal += weight;
      samples++;
    }
  }

  // Generation-weighted mix.
  const wMix = emptyMix();
  let wMixTotal = 0;
  for (const p of genPoints) {
    const weight = mw.get(tsKey(p.from));
    if (weight == null || weight <= 0) continue;
    for (const f of FUELS) wMix[f] += (p.mix[f] ?? 0) * weight;
    wMixTotal += weight;
  }
  const mix = emptyMix();
  if (wMixTotal > 0) for (const f of FUELS) mix[f] = wMix[f] / wMixTotal;

  const result: MonthlyAverage = {
    gco2: wTotal > 0 ? wGco2 / wTotal : 0,
    mix,
    from: from.toISOString(),
    to: to.toISOString(),
    samples,
  };
  if (result.samples > 0) writeCache(cacheKey, result);
  return result;
}
