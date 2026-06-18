// Internal data model (SPEC §3). Everything downstream keys off `Series`,
// never raw API shapes.

export type Fuel =
  | 'gas'
  | 'coal'
  | 'biomass'
  | 'nuclear'
  | 'hydro'
  | 'wind'
  | 'solar'
  | 'imports'
  | 'other';

export const FUELS: Fuel[] = [
  'gas',
  'coal',
  'biomass',
  'nuclear',
  'hydro',
  'wind',
  'solar',
  'imports',
  'other',
];

export type CarbonIndex =
  | 'very low'
  | 'low'
  | 'moderate'
  | 'high'
  | 'very high';

export type FuelMix = Record<Fuel, number>;

export interface Slot {
  ts: string; // ISO UTC, start of the half-hour
  kind: 'actual' | 'forecast';
  gco2: number; // gCO2/kWh (actual if available, else forecast)
  index: CarbonIndex;
  mix: FuelMix; // share in %
  mw?: Partial<FuelMix>; // absolute MW, only if Elexon joined
  price?: number; // p/kWh, only if Octopus joined
}

export interface Series {
  slots: Slot[];
  nowIndex: number; // index of the current slot (latest actual / first forecast)
  region: RegionSelection;
  generatedAt: string; // ISO UTC when this series was assembled
}

// Demand-weighted 30-day baseline (SPEC §4.1, made a true gCO₂/kWh figure).
export interface MonthlyAverage {
  gco2: number; // Σ(intensity×MW)/Σ(MW)
  mix: FuelMix; // generation-weighted average share per fuel, %
  from: string;
  to: string;
  samples: number; // half-hours that contributed
}

export interface RegionSelection {
  // 18 == GB (national). 1-17 are DNO regions.
  regionId: number;
  label: string; // e.g. "Great Britain", "London"
  postcode?: string; // outcode if chosen by postcode
}

export const NATIONAL: RegionSelection = { regionId: 18, label: 'Great Britain' };

export const SLOT_MINUTES = 30;
export const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;
