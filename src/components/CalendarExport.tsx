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

// Tomorrow's single cleanest 2h window — a stable recommendation (today shifts
// as the day passes; tomorrow is fully forecast).
export default function CalendarExport({ series }: Props) {
  const events = bestWindowEvents(series);
  if (!events.length) return null;
  const tomorrow = events[0];

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
        Tomorrow's cleanest 2h window, refreshed automatically. Or add this URL manually:{' '}
        <a href={feedHttps} target="_blank" rel="noreferrer">
          {feedHttps}
        </a>
      </div>
      <div className="cal-links">
        <a href={googleCalendarUrl(tomorrow)} target="_blank" rel="noreferrer">
          {fmtWhen(tomorrow.start)} → Add to Google
        </a>
      </div>
    </div>
  );
}
