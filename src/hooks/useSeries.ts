import { useCallback, useEffect, useState } from 'react';
import { buildRegionalSeries } from '../model/buildSeries';
import { computeMonthlyAverage } from '../model/monthlyAverage';
import type { MonthlyAverage, RegionSelection, Series } from '../model/types';

interface State {
  series: Series | null;
  loading: boolean;
  error: string | null;
}

const REFRESH_MS = 30 * 60 * 1000; // poll on the API's ~30-min cadence

export function useSeries(region: RegionSelection) {
  const [state, setState] = useState<State>({ series: null, loading: true, error: null });
  // National demand-weighted 30-day baseline; loaded once, reused across regions.
  const [monthlyAvg, setMonthlyAvg] = useState<MonthlyAverage | null>(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const series = await buildRegionalSeries(region);
      if (!series.slots.length) throw new Error('No data returned for this region');
      setState({ series, loading: false, error: null });
    } catch (e) {
      setState((s) => ({
        ...s,
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load forecast',
      }));
    }
  }, [region]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // The 30-day average is region-specific and heavy; load it in the background
  // so it never blocks the forecast view, recompute when the region changes,
  // and refresh it daily.
  useEffect(() => {
    let alive = true;
    setMonthlyAvg(null); // clear stale region average while the new one loads
    const run = () =>
      computeMonthlyAverage(region)
        .then((m) => alive && setMonthlyAvg(m))
        .catch(() => {});
    run();
    const id = setInterval(run, 24 * 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [region]);

  return { ...state, monthlyAvg, reload: load };
}
