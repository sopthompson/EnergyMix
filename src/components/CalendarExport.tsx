import type { Series } from '../model/types';
import { googleCalendarUrl } from '../calendar/ics';
import { bestWindowEvents } from '../calendar/windows';

interface Props {
  series: Series;
}

function fmtDay(ts: string | Date): string {
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' });
}

// The cleanest 2h window for each of the days ahead (48h horizon), exportable as
// calendar events so the user can block the time to run heavy appliances.
export default function CalendarExport({ series }: Props) {
  const events = bestWindowEvents(series, 3);
  if (!events.length) return null;

  // Subscribable feed published on the site and refreshed by CI (~4×/day). The
  // webcal: scheme makes calendar apps offer to subscribe and re-poll it.
  const dir = window.location.pathname.replace(/[^/]*$/, '');
  const feedHttps = `${window.location.origin}${dir}calendar.ics`;
  const feedWebcal = feedHttps.replace(/^https?:/, 'webcal:');

  return (
    <div className="cal-export">
      <a className="cal-subscribe" href={feedWebcal}>
        🔄 Subscribe to clean-energy calendar (auto-updates)
      </a>
      <div className="cal-sub">
        The cleanest 2h window each day, refreshed automatically. Or add this URL manually:{' '}
        <a href={feedHttps} target="_blank" rel="noreferrer">
          {feedHttps}
        </a>
      </div>
      <div className="cal-links">
        {events.map((e, k) => (
          <a key={k} href={googleCalendarUrl(e)} target="_blank" rel="noreferrer">
            {fmtDay(e.start)} → Google
          </a>
        ))}
      </div>
    </div>
  );
}
