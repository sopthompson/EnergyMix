// Calendar export — client-only, no backend. Generates a downloadable .ics
// (works with Apple Calendar, Google Calendar import, Outlook) and a Google
// Calendar "template" URL for a single event.

export interface CalEvent {
  start: Date;
  end: Date;
  title: string;
  description: string;
}

// UTC basic format required by iCalendar: YYYYMMDDTHHMMSSZ.
function toUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Escape per RFC 5545 text rules.
function esc(s: string): string {
  return s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

export function buildIcs(events: CalEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Grid Clean//Carbon Forecast//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const stamp = toUtc(new Date());
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${toUtc(e.start)}-${Math.random().toString(36).slice(2, 8)}@gridclean`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toUtc(e.start)}`,
      `DTEND:${toUtc(e.end)}`,
      `SUMMARY:${esc(e.title)}`,
      `DESCRIPTION:${esc(e.description)}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function downloadIcs(filename: string, events: CalEvent[]): void {
  const blob = new Blob([buildIcs(events)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function googleCalendarUrl(e: CalEvent): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${toUtc(e.start)}/${toUtc(e.end)}`,
    details: e.description,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
