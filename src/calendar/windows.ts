// Shared, pure mapping from a forecast Series to calendar events for the
// cleanest 2h window of each day ahead. Used by both the in-browser .ics
// download and the serverless subscription feed, so the two never diverge.

import type { Series } from '../model/types';
import { FUEL_META } from '../model/fuels';
import { dominantFuels, findDailyBestWindows } from '../engine/recommend';
import type { CalEvent } from './ics';

// Today's and tomorrow's cleanest 2h windows. Both are kept so a subscribed feed
// retains today's event when the day rolls over rather than deleting it.
export function bestWindowEvents(series: Series): CalEvent[] {
  return findDailyBestWindows(series, undefined, 48)
    .slice(0, 2)
    .map((w) => {
      const fuels = dominantFuels(series.slots.slice(w.startIndex, w.endIndex + 1))
        .map((f) => FUEL_META[f].label)
        .join(' + ');
      return {
        start: new Date(w.startTs),
        end: new Date(w.endTs),
        title: `Cleanest power · ${Math.round(w.meanGco2)} gCO₂/kWh`,
        description:
          `Greenest 2h window to run heavy appliances (dishwasher, washing, EV charge). ` +
          `Mean ${Math.round(w.meanGco2)} gCO₂/kWh. Dominant: ${fuels}. ` +
          `Source: NESO Carbon Intensity via Grid Clean.`,
      };
    });
}
