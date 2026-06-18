// Shared, pure mapping from a forecast Series to calendar events for the
// cleanest 2h window of each day ahead. Used by both the in-browser .ics
// download and the serverless subscription feed, so the two never diverge.

import type { Series } from '../model/types';
import { FUEL_META } from '../model/fuels';
import { deltaVsNow, dominantFuels, findDailyBestWindows } from '../engine/recommend';
import type { CalEvent } from './ics';

export function bestWindowEvents(series: Series, count = 3): CalEvent[] {
  return findDailyBestWindows(series, undefined, 48)
    .slice(0, count)
    .map((w) => {
      const pct = Math.round(deltaVsNow(series, series.slots[w.startIndex]) * 100);
      const fuels = dominantFuels(series.slots.slice(w.startIndex, w.endIndex + 1))
        .map((f) => FUEL_META[f].label)
        .join(' + ');
      return {
        start: new Date(w.startTs),
        end: new Date(w.endTs),
        title: `Cleanest power · ${Math.round(w.meanGco2)} gCO₂/kWh`,
        description:
          `Greenest 2h window to run heavy appliances (dishwasher, washing, EV charge). ` +
          `Mean ${Math.round(w.meanGco2)} gCO₂/kWh${pct < 0 ? `, ~${Math.abs(pct)}% lower than now` : ''}. ` +
          `Dominant: ${fuels}. Source: NESO Carbon Intensity via Grid Clean.`,
      };
    });
}
