import type { Series } from '../model/types';
import { downloadIcs, googleCalendarUrl } from '../calendar/ics';
import { bestWindowEvents } from '../calendar/windows';

interface Props {
  series: Series;
}

function fmtDay(ts: string | Date): string {
  return new Date(ts).toLocaleDateString('en-GB', { weekday: 'short' });
}
function fmtTime(ts: string | Date): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// The cleanest 2h window for each of the days ahead (48h horizon), exportable as
// calendar events so the user can block the time to run heavy appliances.
export default function CalendarExport({ series }: Props) {
  const events = bestWindowEvents(series, 3);
  if (!events.length) return null;

  const summary = events.map((e) => `${fmtDay(e.start)} ${fmtTime(e.start)}`).join(', ');

  return (
    <div className="cal-export">
      <button className="cal-btn" onClick={() => downloadIcs('grid-clean-windows.ics', events)}>
        ＋ Add best 2h windows to calendar
      </button>
      <div className="cal-sub">Adds {summary} as events (.ics — Apple / Google / Outlook)</div>
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
