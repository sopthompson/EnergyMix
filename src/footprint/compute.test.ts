import { describe, expect, it } from 'vitest';
import {
  computeFootprint,
  computeGasFootprint,
  GAS_KG_CO2_PER_KWH,
  GAS_KWH_PER_M3,
} from './compute';

const HALF_HOUR = 30 * 60 * 1000;

function isoKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

describe('computeFootprint', () => {
  it('weights emissions by consumption and reports your vs grid intensity', () => {
    const now = new Date('2026-06-16T12:00:00Z');
    // Two slots: heavy use in a clean half-hour, light use in a dirty one.
    const t0 = now.getTime() - 2 * HALF_HOUR;
    const t1 = now.getTime() - 1 * HALF_HOUR;
    const consumption = new Map([
      [isoKey(t0), 3], // 3 kWh at 100 g
      [isoKey(t1), 1], // 1 kWh at 300 g
    ]);
    const intensity = new Map([
      [isoKey(t0), 100],
      [isoKey(t1), 300],
    ]);

    const r = computeFootprint(consumption, intensity, now);
    // emissions = 3*100 + 1*300 = 600 gCO₂ = 0.6 kg
    expect(r.lifetime.kgCo2).toBeCloseTo(0.6);
    expect(r.lifetime.kwh).toBe(4);
    // consumption-weighted intensity = 600 / 4 = 150
    expect(r.lifetime.yourIntensity).toBeCloseTo(150);
    // simple grid average over the two slots = (100+300)/2 = 200
    expect(r.lifetime.gridAvgIntensity).toBeCloseTo(200);
    // good timing: your intensity (150) beats the grid average (200)
    expect(r.lifetime.yourIntensity).toBeLessThan(r.lifetime.gridAvgIntensity);
  });

  it('ignores consumption half-hours with no matching intensity', () => {
    const now = new Date('2026-06-16T12:00:00Z');
    const t0 = isoKey(now.getTime() - HALF_HOUR);
    const consumption = new Map([
      [t0, 2],
      ['2026-01-01T00:00', 5], // no intensity → excluded
    ]);
    const intensity = new Map([[t0, 200]]);
    const r = computeFootprint(consumption, intensity, now);
    expect(r.lifetime.slots).toBe(1);
    expect(r.lifetime.kwh).toBe(2);
  });

  it('separates the last 12 months from lifetime', () => {
    const now = new Date('2026-06-16T12:00:00Z');
    const recent = isoKey(now.getTime() - HALF_HOUR);
    const old = isoKey(now.getTime() - 400 * 864e5); // >1y ago
    const consumption = new Map([
      [recent, 1],
      [old, 10],
    ]);
    const intensity = new Map([
      [recent, 200],
      [old, 200],
    ]);
    const r = computeFootprint(consumption, intensity, now);
    expect(r.lifetime.kwh).toBe(11);
    expect(r.lastYear.kwh).toBe(1); // old reading excluded from last year
    expect(r.earliestTs).toBe(old);
  });
});

describe('computeGasFootprint', () => {
  it('converts m³ to kWh and applies the flat gas factor', () => {
    const now = new Date('2026-06-16T12:00:00Z');
    const raw = new Map([
      ['2026-06-14', 10],
      ['2026-06-15', 5],
    ]);
    const r = computeGasFootprint(raw, 'm3', now);
    const expectedKwh = 15 * GAS_KWH_PER_M3;
    expect(r.lifetime.kwh).toBeCloseTo(expectedKwh);
    expect(r.lifetime.kgCo2).toBeCloseTo(expectedKwh * GAS_KG_CO2_PER_KWH);
  });

  it('treats kWh input as-is', () => {
    const now = new Date('2026-06-16T12:00:00Z');
    const raw = new Map([['2026-06-15', 100]]);
    const r = computeGasFootprint(raw, 'kwh', now);
    expect(r.lifetime.kwh).toBeCloseTo(100);
    expect(r.lifetime.kgCo2).toBeCloseTo(100 * GAS_KG_CO2_PER_KWH);
  });
});
