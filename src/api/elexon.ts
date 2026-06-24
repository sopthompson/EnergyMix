// Elexon Insights / BMRS client (SPEC §2.3). Public, no key, CORS-friendly
// (verified: Access-Control-Allow-Origin: *).
//
// Used here only to weight the 30-day average by generation: FUELHH gives MW
// per fuel per half-hour; summed across fuels it is total transmission-metered
// generation, the demand weight for a true gCO₂-per-kWh average. (FUELHH
// excludes embedded solar, so very sunny half-hours are slightly under-weighted
// — documented limitation.)

import { readCache, writeCache } from './cache';

const BASE = 'https://data.elexon.co.uk/bmrs/api/v1';
const TTL_MS = 12 * 60 * 60 * 1000; // monthly data is stable; cache for 12h
const CHUNK_DAYS = 7;

interface FuelHhRow {
  startTime: string; // ISO, half-hour start
  fuelType: string;
  generation: number; // MW
}

async function getJson<T>(url: string, ttl = TTL_MS): Promise<T> {
  const cached = readCache<T>(url, ttl);
  if (cached !== undefined) return cached;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Elexon ${res.status} for ${url}`);
  const json = (await res.json()) as T;
  writeCache(url, json);
  return json;
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function tsKey(iso: string): string {
  return iso.slice(0, 16); // minute precision, matches the carbon API's `from`
}

interface DemandRow {
  boundary: string;
  startTime: string;
  publishTime: string;
  nationalDemand: number;
}

/**
 * National demand forecast (MW) per half-hour over [from, to], keyed by
 * minute-precision timestamp. Boundary "N" is the national figure; where a slot
 * has been re-forecast, the latest publish wins. Covers ~day-ahead.
 */
export async function getDemandForecast(from: Date, to: Date): Promise<Map<string, number>> {
  const url = `${BASE}/forecast/demand/day-ahead?settlementDateFrom=${dateOnly(from)}&settlementDateTo=${dateOnly(to)}&format=json`;
  const json = await getJson<{ data: DemandRow[] }>(url, 30 * 60 * 1000);
  const latest = new Map<string, { pub: string; mw: number }>();
  for (const r of json.data ?? []) {
    if (r.boundary !== 'N') continue;
    const k = tsKey(r.startTime);
    const prev = latest.get(k);
    if (!prev || r.publishTime > prev.pub) latest.set(k, { pub: r.publishTime, mw: r.nationalDemand });
  }
  const out = new Map<string, number>();
  for (const [k, v] of latest) out.set(k, v.mw);
  return out;
}

/**
 * Total generation (MW) per half-hour over [from, to], keyed by minute-precision
 * timestamp. Fetched in weekly chunks to keep responses manageable.
 */
export async function getTotalGenerationMW(from: Date, to: Date): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  for (let start = new Date(from); start < to; start = new Date(start.getTime() + CHUNK_DAYS * 864e5)) {
    const end = new Date(Math.min(start.getTime() + CHUNK_DAYS * 864e5, to.getTime()));
    const url = `${BASE}/datasets/FUELHH?settlementDateFrom=${dateOnly(start)}&settlementDateTo=${dateOnly(end)}&format=json`;
    const json = await getJson<{ data: FuelHhRow[] }>(url);
    for (const row of json.data ?? []) {
      const key = tsKey(row.startTime);
      totals.set(key, (totals.get(key) ?? 0) + (row.generation || 0));
    }
  }
  return totals;
}
