import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildNationalSeries, buildRegionalSeries } from './buildSeries';

const HALF_HOUR = 30 * 60 * 1000;

// A fixed "now" so timestamps are deterministic.
const NOW = new Date('2026-06-15T12:10:00Z');
const slotNow = new Date(Date.parse('2026-06-15T12:00:00Z'));

function iso(ms: number) {
  // Match the API's minute-precision form, e.g. 2026-06-15T12:00Z.
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

// Build a half-hourly intensity payload starting at `from` for `count` slots.
function intensityPayload(fromMs: number, count: number, opts: { actualUntil?: number }) {
  return {
    data: Array.from({ length: count }, (_, k) => {
      const start = fromMs + k * HALF_HOUR;
      const settled = opts.actualUntil != null && start < opts.actualUntil;
      return {
        from: iso(start),
        to: iso(start + HALF_HOUR),
        intensity: { forecast: 200 + k, actual: settled ? 190 + k : null, index: 'moderate' },
      };
    }),
  };
}

function generationPayload(fromMs: number, count: number) {
  return {
    data: Array.from({ length: count }, (_, k) => ({
      from: iso(fromMs + k * HALF_HOUR),
      to: iso(fromMs + (k + 1) * HALF_HOUR),
      generationmix: [
        { fuel: 'gas', perc: 50 },
        { fuel: 'wind', perc: 30 },
        { fuel: 'nuclear', perc: 20 },
      ],
    })),
  };
}

function regionalPayload(fromMs: number, count: number, regionid: number) {
  return {
    data: {
      regionid,
      shortname: regionid === 18 ? 'GB' : 'London',
      data: Array.from({ length: count }, (_, k) => ({
        from: iso(fromMs + k * HALF_HOUR),
        to: iso(fromMs + (k + 1) * HALF_HOUR),
        intensity: { forecast: 150 + k, index: 'low' },
        generationmix: [
          { fuel: 'gas', perc: 20 },
          { fuel: 'wind', perc: 70 },
          { fuel: 'nuclear', perc: 10 },
        ],
      })),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('buildNationalSeries', () => {
  it('joins national intensity with a forward mix and marks the now boundary', async () => {
    const tailFrom = slotNow.getTime() - 12 * 3600 * 1000; // floor(now-12h) = 00:00

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        let body: unknown;
        if (url.includes('/regional/intensity/')) {
          body = regionalPayload(slotNow.getTime(), 96, 18);
        } else if (url.includes('/fw48h')) {
          // National forward from slotNow: all forecast.
          body = intensityPayload(slotNow.getTime(), 96, { actualUntil: slotNow.getTime() });
        } else if (url.includes('/generation/')) {
          body = generationPayload(tailFrom, 24); // 12h tail mix
        } else if (url.includes('/intensity/')) {
          // Past actual tail as an explicit range (00:00–12:00, all settled).
          body = intensityPayload(tailFrom, 24, { actualUntil: slotNow.getTime() });
        } else {
          throw new Error(`unexpected url ${url}`);
        }
        return { ok: true, json: async () => body } as Response;
      }),
    );

    const series = await buildNationalSeries(NOW);

    expect(series.slots.length).toBeGreaterThan(24);
    // nowIndex sits on the slot covering 12:00–12:30.
    expect(series.slots[series.nowIndex].ts).toBe('2026-06-15T12:00Z');
    // Slots before now are settled actuals; from now on they are forecast.
    expect(series.slots[series.nowIndex - 1].kind).toBe('actual');
    expect(series.slots[series.nowIndex + 1].kind).toBe('forecast');
    // Forward slots take the GB regional mix (wind-heavy 70%).
    expect(series.slots[series.nowIndex + 1].mix.wind).toBe(70);
    // The actual tail takes the national generation mix (gas-heavy 50%).
    expect(series.slots[series.nowIndex - 1].mix.gas).toBe(50);
  });
});

describe('buildRegionalSeries', () => {
  it('uses the regional forecast for both intensity and mix, now at index 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('/regional/intensity/')) throw new Error(`unexpected url ${url}`);
        return {
          ok: true,
          json: async () => regionalPayload(slotNow.getTime(), 8, 13),
        } as Response;
      }),
    );

    const series = await buildRegionalSeries({ regionId: 13, label: 'London' }, NOW);
    expect(series.nowIndex).toBe(0);
    expect(series.slots.every((s) => s.kind === 'forecast')).toBe(true);
    expect(series.slots[0].mix.wind).toBe(70);
    expect(series.slots[0].gco2).toBe(150);
  });
});
