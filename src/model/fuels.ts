import type { Fuel } from './types';

// Carbon "direction" of each fuel. More of a clean fuel (or less of a dirty
// one) helps; the scrub readout colours per-source deltas by this, not by raw
// sign (SPEC §5.4).
export type FuelDirection = 'clean' | 'dirty' | 'neutral';

export interface FuelMeta {
  label: string;
  direction: FuelDirection;
  color: string; // stacked-area fill (mix mode)
}

// Order here is the stacking order, dirtiest at the bottom up to cleanest, so
// the green band sits visually on top of the gas/imports base.
export const FUEL_META: Record<Fuel, FuelMeta> = {
  coal: { label: 'Coal', direction: 'dirty', color: '#4b5563' },
  gas: { label: 'Gas', direction: 'dirty', color: '#a16207' },
  imports: { label: 'Imports', direction: 'dirty', color: '#9333ea' },
  other: { label: 'Other', direction: 'neutral', color: '#6b7280' },
  biomass: { label: 'Biomass', direction: 'neutral', color: '#b45309' },
  nuclear: { label: 'Nuclear', direction: 'clean', color: '#06b6d4' },
  hydro: { label: 'Hydro', direction: 'clean', color: '#2563eb' },
  solar: { label: 'Solar', direction: 'clean', color: '#eab308' },
  wind: { label: 'Wind', direction: 'clean', color: '#22c55e' },
};

// Bottom-to-top stack order (dirty base first).
export const STACK_ORDER: Fuel[] = [
  'coal',
  'gas',
  'imports',
  'other',
  'biomass',
  'nuclear',
  'hydro',
  'solar',
  'wind',
];

// For a given fuel, does an increase in its share help carbon (clean) or hurt
// (dirty)? Returns +1 if a positive delta is good, -1 if a positive delta is
// bad, 0 if neutral.
export function helpSign(fuel: Fuel): number {
  const d = FUEL_META[fuel].direction;
  return d === 'clean' ? 1 : d === 'dirty' ? -1 : 0;
}
