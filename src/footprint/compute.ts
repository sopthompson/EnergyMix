// Pure personal-footprint compute: combine the user's half-hourly consumption
// (kWh) with the matching half-hourly grid intensity (gCO₂/kWh) into emissions.
// No network, no UI — runs identically in the browser now and on a backend
// after launch.
//
//   emissions = Σ(kWh_t × intensity_t)          (true, consumption-weighted)
//   yourIntensity = Σ(kWh_t × intensity_t) / Σ(kWh_t)
//
// `yourIntensity` vs the period's grid average is the headline: it shows whether
// *when* you use power beats using it at random.

export interface FootprintPeriod {
  label: string;
  fromTs: string | null;
  toTs: string | null;
  kwh: number;
  kgCo2: number;
  yourIntensity: number; // gCO₂/kWh, consumption-weighted
  gridAvgIntensity: number; // gCO₂/kWh, simple average over the same slots
  slots: number;
}

export interface FootprintResult {
  lastYear: FootprintPeriod;
  lifetime: FootprintPeriod;
  earliestTs: string | null;
}

// Parse a timestamp key to epoch ms. Keys are "YYYY-MM-DD" (daily gas) or
// "YYYY-MM-DDTHH:MM" (half-hourly), both treated as UTC.
function keyToMs(key: string): number {
  return Date.parse(key.length <= 10 ? `${key}T00:00:00Z` : `${key}:00Z`);
}

// Timestamp key one year before the latest reading (so a stale account still
// yields a populated "recent 12 months" rather than an empty wall-clock window).
function yearBefore(latestTs: string): string {
  return new Date(keyToMs(latestTs) - 365 * 864e5).toISOString().slice(0, 16);
}

function summarise(
  label: string,
  pairs: Array<{ ts: string; kwh: number; gco2: number }>,
): FootprintPeriod {
  let kwh = 0;
  let gEmit = 0; // total gCO₂
  let gSum = 0; // sum of intensities (for simple average)
  for (const p of pairs) {
    kwh += p.kwh;
    gEmit += p.kwh * p.gco2;
    gSum += p.gco2;
  }
  return {
    label,
    fromTs: pairs.length ? pairs[0].ts : null,
    toTs: pairs.length ? pairs[pairs.length - 1].ts : null,
    kwh,
    kgCo2: gEmit / 1000,
    yourIntensity: kwh > 0 ? gEmit / kwh : 0,
    gridAvgIntensity: pairs.length ? gSum / pairs.length : 0,
    slots: pairs.length,
  };
}

// --- gas ---

// UK natural-gas combustion factor (DEFRA/BEIS): ~0.183 kgCO₂e per kWh. Unlike
// electricity it's effectively constant, so no half-hourly intensity is needed.
export const GAS_KG_CO2_PER_KWH = 0.183;
// m³ → kWh for gas (volume correction 1.02264 × calorific value 39.5 MJ/m³ ÷ 3.6).
export const GAS_KWH_PER_M3 = (1.02264 * 39.5) / 3.6;

export type GasUnit = 'm3' | 'kwh';

export interface GasPeriod {
  label: string;
  fromTs: string | null;
  toTs: string | null;
  kwh: number;
  kgCo2: number;
}

export interface GasFootprint {
  lastYear: GasPeriod;
  lifetime: GasPeriod;
}

function gasPeriod(label: string, entries: Array<{ ts: string; kwh: number }>): GasPeriod {
  const kwh = entries.reduce((a, e) => a + e.kwh, 0);
  return {
    label,
    fromTs: entries.length ? entries[0].ts : null,
    toTs: entries.length ? entries[entries.length - 1].ts : null,
    kwh,
    kgCo2: kwh * GAS_KG_CO2_PER_KWH,
  };
}

export function computeGasFootprint(
  raw: Map<string, number>,
  unit: GasUnit,
  now = new Date(),
): GasFootprint {
  const factor = unit === 'm3' ? GAS_KWH_PER_M3 : 1;
  const entries = [...raw.entries()]
    .map(([ts, v]) => ({ ts, kwh: v * factor }))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const latestTs = entries.length ? entries[entries.length - 1].ts : now.toISOString().slice(0, 16);
  const yearAgo = yearBefore(latestTs);

  return {
    lastYear: gasPeriod('Most recent 12 months', entries.filter((e) => e.ts >= yearAgo)),
    lifetime: gasPeriod('Since earliest reading', entries),
  };
}

export function computeFootprint(
  consumption: Map<string, number>,
  intensity: Map<string, number>,
  now = new Date(),
): FootprintResult {
  // Join on timestamps present in both, sorted chronologically.
  const pairs: Array<{ ts: string; kwh: number; gco2: number }> = [];
  for (const [ts, kwh] of consumption) {
    const gco2 = intensity.get(ts);
    if (gco2 != null) pairs.push({ ts, kwh, gco2 });
  }
  pairs.sort((a, b) => a.ts.localeCompare(b.ts));

  // Anchor the recent window to the latest reading, not wall-clock now, so it
  // still shows data when an account's readings have stopped (e.g. supplier
  // switch) rather than reporting an empty "last 12 months".
  const latestTs = pairs.length ? pairs[pairs.length - 1].ts : now.toISOString().slice(0, 16);
  const yearAgo = yearBefore(latestTs);
  const recentPairs = pairs.filter((p) => p.ts >= yearAgo);

  return {
    lastYear: summarise('Most recent 12 months', recentPairs),
    lifetime: summarise('Since earliest reading', pairs),
    earliestTs: pairs.length ? pairs[0].ts : null,
  };
}
