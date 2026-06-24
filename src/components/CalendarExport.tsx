import type { Series } from '../model/types';
import { googleCalendarUrl } from '../calendar/ics';
import { bestWindowEvents } from '../calendar/windows';

interface Props {
  series: Series;
}

function fmtWhen(ts: string | Date): string {
  return new Date(ts).toLocaleString('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Today's and tomorrow's cleanest 2h windows.
export default function CalendarExport({ series }: Props) {
  const events = bestWindowEvents(series);
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
        Today's & tomorrow's cleanest 2h windows, refreshed automatically. Or add this URL manually:{' '}
        <a href={feedHttps} target="_blank" rel="noreferrer">
          {feedHttps}
        </a>
      </div>
      <div className="cal-links">
        {events.map((e, k) => (
          <a key={k} href={googleCalendarUrl(e)} target="_blank" rel="noreferrer">
            {fmtWhen(e.start)} → Google
          </a>
        ))}
      </div>
    </div>
  );
}
