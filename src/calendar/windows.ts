// Shared, pure mapping from a forecast Series to calendar events for the
// cleanest 2h window of each day ahead. Used by both the in-browser .ics
// download and the serverless subscription feed, so the two never diverge.

import type { Series } from '../model/types';
import { FUEL_META } from '../model/fuels';
import { dominantFuels, findNextDayBestWindow } from '../engine/recommend';
import type { CalEvent } from './ics';

// A single, stable recommendation: the cleanest 2h window for the next full day
// (tomorrow). Today's window shrinks as the day passes and the day-2 window sits
// at the ragged edge of the forecast, so both churn — tomorrow does not.
export function bestWindowEvents(series: Series): CalEvent[] {
  const w = findNextDayBestWindow(series);
  if (!w) return [];
  const fuels = dominantFuels(series.slots.slice(w.startIndex, w.endIndex + 1))
    .map((f) => FUEL_META[f].label)
    .join(' + ');
  return [
    {
      start: new Date(w.startTs),
      end: new Date(w.endTs),
      title: `Cleanest power · ${Math.round(w.meanGco2)} gCO₂/kWh`,
      description:
        `Greenest 2h window tomorrow to run heavy appliances (dishwasher, washing, EV charge). ` +
        `Mean ${Math.round(w.meanGco2)} gCO₂/kWh. Dominant: ${fuels}. ` +
        `Source: NESO Carbon Intensity via Grid Clean.`,
    },
  ];
}
