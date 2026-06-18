// Load half-hourly grid intensity (gCO₂/kWh) over an arbitrary span for the
// footprint calc, chunked to respect the carbon API's per-request range limits
// and cached. National uses settled actuals; regional uses NESO's regional
// estimate (no settled actual exists per region).

import { getIntensityRange, getRegionalIntensityRange } from '../api/carbon';

export type IntensityBasis = { kind: 'national' } | { kind: 'regional'; regionId: number };

function tsKey(iso: string): string {
  return iso.slice(0, 16);
}

export async function loadIntensitySeries(
  from: Date,
  to: Date,
  basis: IntensityBasis,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const chunkDays = basis.kind === 'national' ? 30 : 14;
  const chunkMs = chunkDays * 864e5;
  const starts: Date[] = [];
  for (let s = from.getTime(); s < to.getTime(); s += chunkMs) starts.push(new Date(s));

  const out = new Map<string, number>();
  let done = 0;
  for (const start of starts) {
    const end = new Date(Math.min(start.getTime() + chunkMs, to.getTime()));
    const points =
      basis.kind === 'national'
        ? await getIntensityRange(start, end)
        : await getRegionalIntensityRange(start, end, basis.regionId);
    for (const p of points) {
      const g = p.actual ?? p.forecast;
      if (g != null) out.set(tsKey(p.from), g);
    }
    onProgress?.(++done, starts.length);
  }
  return out;
}
