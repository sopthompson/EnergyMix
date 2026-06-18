// Orchestrates a personal-footprint calculation: meter → consumption → matching
// grid intensity → pure compute. Kept separate from React/UI so the only thing
// that changes at website launch is where the authed Octopus calls run (a
// backend instead of the browser).

import {
  getConsumption,
  getElectricityMeters,
  getGasConsumption,
  getGasMeters,
} from '../api/octopusAccount';
import { loadIntensitySeries, type IntensityBasis } from './intensity';
import {
  computeFootprint,
  computeGasFootprint,
  type FootprintResult,
  type GasFootprint,
  type GasUnit,
} from './compute';

// The carbon-intensity API has no data before ~May 2018, so consumption is not
// fetched earlier than this (and pre-smart-meter half-hourly data won't exist).
const INTENSITY_FLOOR = new Date('2018-05-10T00:00:00Z');

export interface FootprintParams {
  apiKey: string;
  account: string;
  basis: IntensityBasis;
  gasUnit: GasUnit;
}

export interface FullFootprint {
  electricity: FootprintResult;
  gas: GasFootprint | null;
}

export async function calculateFootprint(
  p: FootprintParams,
  onStatus?: (msg: string) => void,
): Promise<FullFootprint> {
  onStatus?.('Finding your meter…');
  const meters = await getElectricityMeters(p.apiKey, p.account);

  const now = new Date();
  onStatus?.('Fetching your half-hourly consumption…');
  // Merge every meter serial (periods are disjoint across re-commissions).
  const consumption = new Map<string, number>();
  for (const meter of meters) {
    const part = await getConsumption(p.apiKey, meter, INTENSITY_FLOOR, now);
    for (const [ts, kwh] of part) consumption.set(ts, kwh);
  }
  if (!consumption.size) {
    throw new Error('No half-hourly consumption returned — is this a smart meter on half-hourly readings?');
  }

  const earliest = [...consumption.keys()].sort()[0];
  const from = new Date(`${earliest}:00Z`);

  onStatus?.('Loading grid carbon intensity…');
  const intensity = await loadIntensitySeries(from, now, p.basis, (done, total) =>
    onStatus?.(`Loading grid carbon intensity… ${done}/${total}`),
  );

  // Gas (optional — only if the account has a gas meter). Flat emission factor,
  // so no grid intensity needed.
  onStatus?.('Checking for gas…');
  let gas: GasFootprint | null = null;
  const gasMeters = await getGasMeters(p.apiKey, p.account).catch(() => []);
  if (gasMeters.length) {
    onStatus?.('Fetching your gas consumption…');
    const gasRaw = new Map<string, number>();
    for (const meter of gasMeters) {
      const part = await getGasConsumption(p.apiKey, meter, INTENSITY_FLOOR, now).catch(
        () => new Map<string, number>(),
      );
      for (const [ts, v] of part) gasRaw.set(ts, v);
    }
    if (gasRaw.size) gas = computeGasFootprint(gasRaw, p.gasUnit, now);
  }

  onStatus?.('Calculating…');
  return { electricity: computeFootprint(consumption, intensity, now), gas };
}
