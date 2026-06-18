import { useEffect, useState } from 'react';
import { getAgileRates } from '../api/octopus';
import { gspForRegion, gspRegionLabel } from '../model/gsp';
import { NATIONAL, type RegionSelection } from '../model/types';

interface PriceState {
  prices: Map<string, number> | null; // keyed by minute-precision ts (slice 0,16)
  gspLabel: string | null; // which region the prices are for
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 30 * 60 * 1000;
const EMPTY: PriceState = { prices: null, gspLabel: null, loading: false, error: null };

/**
 * Octopus Agile half-hourly rates for the selected region, loaded only when the
 * price overlay is enabled. National (GB) falls back to a representative region,
 * surfaced via `gspLabel` so cost is never silently passed off as national.
 */
export function usePrice(region: RegionSelection, enabled: boolean): PriceState {
  const [state, setState] = useState<PriceState>(EMPTY);

  useEffect(() => {
    if (!enabled) {
      setState(EMPTY);
      return;
    }
    let alive = true;
    const { letter, regionId } = gspForRegion(region.regionId);
    const isFallback = region.regionId === NATIONAL.regionId;
    const label = isFallback ? `${gspRegionLabel(regionId)} (GB has no single tariff)` : region.label;

    const load = async () => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const now = new Date();
        const from = new Date(now.getTime() - 12 * 3600 * 1000);
        const to = new Date(now.getTime() + 48 * 3600 * 1000);
        const prices = await getAgileRates(letter, from, to);
        if (alive) setState({ prices, gspLabel: label, loading: false, error: null });
      } catch (e) {
        if (alive)
          setState({
            prices: null,
            gspLabel: label,
            loading: false,
            error: e instanceof Error ? e.message : 'Failed to load Agile prices',
          });
      }
    };

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [region, enabled]);

  return state;
}
