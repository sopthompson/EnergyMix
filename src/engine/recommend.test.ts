import { describe, expect, it } from 'vitest';
import {
  baselineValue,
  classifyWindows,
  deltaVsNow,
  dominantFuels,
  findBestWindow,
  findDailyBestWindows,
  findTopWindows,
  nowSlot,
  percentileToday,
  perSourceDelta,
  quantile,
} from './recommend';
import { FUELS, type Fuel, type FuelMix, type Series, type Slot } from '../model/types';

const HALF_HOUR = 30 * 60 * 1000;
const T0 = Date.parse('2026-06-15T12:00:00Z');

function mix(partial: Partial<FuelMix>): FuelMix {
  const m = {} as FuelMix;
  for (const f of FUELS) m[f] = partial[f] ?? 0;
  return m;
}

/**
 * Build a series where index `nowIndex` is "now". gco2 values drive the
 * intensity; mixes default to all-gas unless overridden per index.
 */
function makeSeries(
  gco2: number[],
  nowIndex: number,
  mixes: Record<number, Partial<FuelMix>> = {},
): Series {
  const slots: Slot[] = gco2.map((g, i) => ({
    ts: new Date(T0 + i * HALF_HOUR).toISOString(),
    kind: i < nowIndex ? 'actual' : 'forecast',
    gco2: g,
    index: 'moderate',
    mix: mix(mixes[i] ?? { gas: 100 }),
  }));
  return { slots, nowIndex, region: { regionId: 18, label: 'GB' }, generatedAt: '' };
}

describe('quantile', () => {
  it('interpolates linearly', () => {
    expect(quantile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5);
    expect(quantile([10, 20, 30, 40], 0.5)).toBeCloseTo(25);
    expect(quantile([10, 20, 30, 40], 0.75)).toBeCloseTo(32.5);
  });
  it('handles single and empty', () => {
    expect(quantile([42], 0.5)).toBe(42);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});

describe('deltaVsNow', () => {
  it('is signed fraction vs the now slot', () => {
    const s = makeSeries([200, 100, 300], 0); // now = 200
    expect(deltaVsNow(s, s.slots[1])).toBeCloseTo(-0.5);
    expect(deltaVsNow(s, s.slots[2])).toBeCloseTo(0.5);
    expect(deltaVsNow(s, nowSlot(s))).toBe(0);
  });
});

describe('percentileToday', () => {
  it('ranks within the forward window (0 = cleanest)', () => {
    const s = makeSeries([100, 200, 300, 400], 0);
    expect(percentileToday(s, s.slots[0])).toBeCloseTo(0.125); // cleanest
    expect(percentileToday(s, s.slots[3])).toBeCloseTo(0.875); // dirtiest
  });
});

describe('baselineValue', () => {
  it('vs now returns the now level; vs average returns the mean', () => {
    const s = makeSeries([100, 200, 300], 0);
    expect(baselineValue(s, 'now')).toBe(100);
    expect(baselineValue(s, 'average')).toBeCloseTo(200); // falls back to window mean
    expect(baselineValue(s, 'average', { gco2: 150, mix: {} as never, from: '', to: '', samples: 1 })).toBe(150);
  });
});

describe('findBestWindow', () => {
  it('finds the cleanest contiguous run and computes saving vs now', () => {
    // now = 200. Cleanest 2-slot run is indices 3-4 (50+50=100).
    const s = makeSeries([200, 180, 160, 50, 50, 300], 0);
    const best = findBestWindow(s, 2)!;
    expect(best.startIndex).toBe(3);
    expect(best.totalGco2).toBe(100);
    expect(best.meanGco2).toBe(50);
    // run-now over 2 slots = 200 + 180 = 380; saving = (380-100)/380
    expect(best.runNowGco2).toBe(380);
    expect(best.savingVsNow).toBeCloseTo((380 - 100) / 380);
  });

  it('respects earliestStart and deadline', () => {
    const s = makeSeries([200, 10, 10, 300, 5, 5, 5], 0);
    // Without bounds the cleanest 2-slot window starts at index 4 (5+5).
    expect(findBestWindow(s, 2)!.startIndex).toBe(4);
    // With a deadline before index 4's window finishes, falls back to 1-2.
    const deadline = new Date(T0 + 3 * HALF_HOUR); // end of index 2
    expect(findBestWindow(s, 2, { deadline })!.startIndex).toBe(1);
  });

  it('returns null when the window cannot fit', () => {
    const s = makeSeries([200, 100], 0);
    expect(findBestWindow(s, 5)).toBeNull();
  });
});

describe('findTopWindows', () => {
  it('returns non-overlapping windows ordered by time', () => {
    const s = makeSeries([10, 10, 300, 300, 20, 20, 300, 5, 5], 0);
    const tops = findTopWindows(s, 2, 2);
    expect(tops).toHaveLength(2);
    // chosen windows must not overlap
    const [a, b] = tops;
    expect(a.endIndex < b.startIndex || b.endIndex < a.startIndex).toBe(true);
    // ordered by start time
    expect(a.startIndex).toBeLessThan(b.startIndex);
  });
});

describe('findDailyBestWindows', () => {
  it('returns one lowest-average window per day, surfacing a later-day dip', () => {
    // 48h of mostly-300 grid with a clean dip far out (≈40h), on a later day.
    const gco2 = new Array(96).fill(300);
    for (let i = 80; i <= 85; i++) gco2[i] = 40;
    const s = makeSeries(gco2, 0);

    const windows = findDailyBestWindows(s, 4, 48);
    expect(windows.length).toBeGreaterThanOrEqual(2);
    // Every window is exactly the 2h (4-slot) duration.
    for (const w of windows) expect(w.endIndex - w.startIndex + 1).toBe(4);
    // Windows are time-ordered and non-overlapping.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].startIndex).toBeGreaterThan(windows[i - 1].endIndex);
    }
    // The dip is surfaced as the best window of its day, even though it sits
    // beyond the first 24h and the earlier day is uniformly worse.
    const dipWindow = windows.find((w) => w.meanGco2 < 100);
    expect(dipWindow).toBeTruthy();
    expect(dipWindow!.startIndex).toBeGreaterThanOrEqual(80);
    expect(dipWindow!.startIndex).toBeLessThanOrEqual(82);
  });
});

describe('classifyWindows', () => {
  it('marks runs below p25 recommended and above p75 avoid', () => {
    // Clear low block at start, high block at end.
    const gco2 = [50, 50, 50, 200, 200, 350, 350, 350];
    const s = makeSeries(gco2, 0);
    const cuts = classifyWindows(s, { minSlots: 2 });
    const rec = cuts.find((c) => c.kind === 'recommended');
    const avoid = cuts.find((c) => c.kind === 'avoid');
    expect(rec).toBeTruthy();
    expect(avoid).toBeTruthy();
    expect(rec!.startIndex).toBe(0);
    expect(avoid!.endIndex).toBe(7);
    expect(rec!.meanGco2).toBeLessThan(avoid!.meanGco2);
  });

  it('drops runs shorter than minSlots', () => {
    // The two cleanest slots (50, 60) sit below p25 but are non-adjacent, so
    // each is a lone run shorter than minSlots.
    const s = makeSeries([50, 300, 60, 300, 300, 300], 0);
    const cuts = classifyWindows(s, { minSlots: 2 });
    // Neither lone clean slot is long enough to be recommended.
    expect(cuts.some((c) => c.kind === 'recommended')).toBe(false);
  });

  it('reports dominant fuels for a window', () => {
    const s = makeSeries([50, 50], 0, {
      0: { wind: 60, gas: 40 },
      1: { wind: 70, gas: 30 },
    });
    const cuts = classifyWindows(s, { minSlots: 2 });
    expect(cuts[0]?.dominantFuels[0]).toBe<Fuel>('wind');
  });
});

describe('perSourceDelta', () => {
  it('computes pp deltas and colours by carbon direction', () => {
    const s = makeSeries([200, 150], 0, {
      0: { wind: 20, gas: 80 },
      1: { wind: 50, gas: 50 },
    });
    const deltas = perSourceDelta(s, s.slots[1]);
    const wind = deltas.find((d) => d.fuel === 'wind')!;
    const gas = deltas.find((d) => d.fuel === 'gas')!;
    expect(wind.deltaPp).toBeCloseTo(30);
    expect(wind.helps).toBe(true); // more wind helps
    expect(gas.deltaPp).toBeCloseTo(-30);
    expect(gas.helps).toBe(true); // less gas also helps
    expect(gas.helpful).toBeGreaterThan(0);
  });

  it('all deltas are zero at the now slot', () => {
    const s = makeSeries([200, 150], 0, { 0: { wind: 30, gas: 70 } });
    for (const d of perSourceDelta(s, nowSlot(s))) {
      expect(d.deltaPp).toBe(0);
      expect(d.helpful).toBe(0);
    }
  });
});

describe('dominantFuels', () => {
  it('returns top fuels by mean share', () => {
    const s = makeSeries([1, 1], 0, {
      0: { gas: 50, wind: 30, nuclear: 20 },
      1: { gas: 40, wind: 40, nuclear: 20 },
    });
    expect(dominantFuels(s.slots, 2)).toEqual<Fuel[]>(['gas', 'wind']);
  });
});
