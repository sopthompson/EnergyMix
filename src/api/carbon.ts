// Typed client for the NESO Carbon Intensity API (SPEC §2.1). No auth, JSON,
// half-hourly slots, all times UTC. Responses are cached on the documented
// ~30-min refresh cadence.
//
// Endpoint shapes were verified live against api.carbonintensity.org.uk; the
// national `fw48h` endpoint returns intensity only, so the GB regional
// forecast (regionId 18) is used to source the forward generation mix.

import { readCache, writeCache } from './cache';
import type { CarbonIndex, Fuel } from '../model/types';
import { FUELS } from '../model/types';

const BASE = 'https://api.carbonintensity.org.uk';
const CACHE_MS = 30 * 60 * 1000; // 30 minutes

// ----- raw API response shapes -----

interface RawIntensityBlock {
  forecast: number | null;
  actual: number | null;
  index: string;
}

interface RawIntensityPeriod {
  from: string;
  to: string;
  intensity: RawIntensityBlock;
}

interface RawGenerationEntry {
  fuel: string;
  perc: number;
}

interface RawGenerationPeriod {
  from: string;
  to: string;
  generationmix: RawGenerationEntry[];
}

interface RawRegionalPeriod {
  from: string;
  to: string;
  intensity: { forecast: number | null; index: string };
  generationmix: RawGenerationEntry[];
}

// ----- normalised return shapes -----

export interface IntensityPoint {
  from: string;
  to: string;
  forecast: number | null;
  actual: number | null;
  index: CarbonIndex;
}

export interface MixPoint {
  from: string;
  to: string;
  mix: Partial<Record<Fuel, number>>;
}

export interface RegionalForecastPoint extends IntensityPoint {
  mix: Partial<Record<Fuel, number>>;
}

export interface RegionInfo {
  regionid: number;
  shortname: string;
  dnoregion?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const cached = readCache<T>(url, CACHE_MS);
  if (cached !== undefined) return cached;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Carbon API ${res.status} for ${url}`);
  }
  const json = (await res.json()) as T;
  writeCache(url, json);
  return json;
}

function normIndex(raw: string): CarbonIndex {
  const valid: CarbonIndex[] = ['very low', 'low', 'moderate', 'high', 'very high'];
  return (valid as string[]).includes(raw) ? (raw as CarbonIndex) : 'moderate';
}

function normMix(entries: RawGenerationEntry[]): Partial<Record<Fuel, number>> {
  const out: Partial<Record<Fuel, number>> = {};
  for (const e of entries) {
    if ((FUELS as string[]).includes(e.fuel)) {
      out[e.fuel as Fuel] = e.perc;
    }
  }
  return out;
}

// ISO with seconds stripped to the minute and a trailing Z, the form the API
// path parameters expect (e.g. 2026-06-15T12:00Z).
export function toApiTime(d: Date): string {
  return d.toISOString().slice(0, 16) + 'Z';
}

/** Current national intensity snapshot. */
export async function getCurrentIntensity(): Promise<IntensityPoint> {
  const json = await getJson<{ data: RawIntensityPeriod[] }>(`${BASE}/intensity`);
  const p = json.data[0];
  return {
    from: p.from,
    to: p.to,
    forecast: p.intensity.forecast,
    actual: p.intensity.actual,
    index: normIndex(p.intensity.index),
  };
}

/** National forward 48h intensity (authoritative; forecast + settled actuals). */
export async function getNationalForward(from: Date): Promise<IntensityPoint[]> {
  const json = await getJson<{ data: RawIntensityPeriod[] }>(
    `${BASE}/intensity/${toApiTime(from)}/fw48h`,
  );
  return json.data.map((p) => ({
    from: p.from,
    to: p.to,
    forecast: p.intensity.forecast,
    actual: p.intensity.actual,
    index: normIndex(p.intensity.index),
  }));
}

/** National intensity over an explicit range (used for the recent actual tail). */
export async function getIntensityRange(from: Date, to: Date): Promise<IntensityPoint[]> {
  const json = await getJson<{ data: RawIntensityPeriod[] }>(
    `${BASE}/intensity/${toApiTime(from)}/${toApiTime(to)}`,
  );
  return json.data.map((p) => ({
    from: p.from,
    to: p.to,
    forecast: p.intensity.forecast,
    actual: p.intensity.actual,
    index: normIndex(p.intensity.index),
  }));
}

/** National generation mix over a range (history only; no forward variant). */
export async function getGenerationRange(from: Date, to: Date): Promise<MixPoint[]> {
  const json = await getJson<{ data: RawGenerationPeriod[] }>(
    `${BASE}/generation/${toApiTime(from)}/${toApiTime(to)}`,
  );
  return json.data.map((p) => ({ from: p.from, to: p.to, mix: normMix(p.generationmix) }));
}

/**
 * Regional forward 48h forecast bundling intensity AND generation mix.
 * regionId 18 == GB (national); 1-17 are DNO regions. This is the only public
 * source of a forward mix, so the national view uses regionId 18 here.
 */
export async function getRegionalForward(
  from: Date,
  regionId: number,
): Promise<RegionalForecastPoint[]> {
  const json = await getJson<{ data: { data: RawRegionalPeriod[] } }>(
    `${BASE}/regional/intensity/${toApiTime(from)}/fw48h/regionid/${regionId}`,
  );
  return json.data.data.map((p) => ({
    from: p.from,
    to: p.to,
    forecast: p.intensity.forecast,
    actual: null,
    index: normIndex(p.intensity.index),
    mix: normMix(p.generationmix),
  }));
}

/**
 * Regional intensity over an explicit range (NESO's regional estimate — the
 * `forecast` value; regional has no settled "actual"). Used for the regional
 * personal-footprint basis.
 */
export async function getRegionalIntensityRange(
  from: Date,
  to: Date,
  regionId: number,
): Promise<IntensityPoint[]> {
  const json = await getJson<{ data: { data: RawRegionalPeriod[] } }>(
    `${BASE}/regional/intensity/${toApiTime(from)}/${toApiTime(to)}/regionid/${regionId}`,
  );
  return json.data.data.map((p) => ({
    from: p.from,
    to: p.to,
    forecast: p.intensity.forecast,
    actual: null,
    index: normIndex(p.intensity.index),
  }));
}

/**
 * Regional intensity + generation mix over an explicit range (NESO's regional
 * estimate). Used to draw the recent history tail for a DNO-region view.
 */
export async function getRegionalRange(
  from: Date,
  to: Date,
  regionId: number,
): Promise<RegionalForecastPoint[]> {
  const json = await getJson<{ data: { data: RawRegionalPeriod[] } }>(
    `${BASE}/regional/intensity/${toApiTime(from)}/${toApiTime(to)}/regionid/${regionId}`,
  );
  return json.data.data.map((p) => ({
    from: p.from,
    to: p.to,
    forecast: p.intensity.forecast,
    actual: null,
    index: normIndex(p.intensity.index),
    mix: normMix(p.generationmix),
  }));
}

/** List of DNO regions (id -> shortname) for the region selector. */
export async function getRegions(): Promise<RegionInfo[]> {
  const json = await getJson<{ data: Array<{ regions: RegionInfo[] }> }>(`${BASE}/regional`);
  return json.data[0].regions;
}

/** Resolve a postcode outcode (e.g. "S1") to its DNO region. */
export async function getRegionByPostcode(outcode: string): Promise<RegionInfo | null> {
  const clean = outcode.trim().toUpperCase();
  const json = await getJson<{ data: RegionInfo[] | null }>(
    `${BASE}/regional/postcode/${encodeURIComponent(clean)}`,
  );
  return json.data && json.data.length ? json.data[0] : null;
}
