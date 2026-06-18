import { describe, expect, it } from 'vitest';
import { buildIcs, googleCalendarUrl, type CalEvent } from './ics';

const event: CalEvent = {
  start: new Date('2026-06-17T02:00:00Z'),
  end: new Date('2026-06-17T04:00:00Z'),
  title: 'Cleanest power · 95 gCO₂/kWh',
  description: 'Greenest 2h window; dominant: Wind, Nuclear.',
};

describe('buildIcs', () => {
  it('produces a valid single-event calendar with UTC basic times', () => {
    const ics = buildIcs([event]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART:20260617T020000Z');
    expect(ics).toContain('DTEND:20260617T040000Z');
    expect(ics).toContain('SUMMARY:Cleanest power · 95 gCO₂/kWh');
    expect(ics).toMatch(/\r\n/); // CRLF line endings
  });

  it('escapes commas in the description per RFC 5545', () => {
    const ics = buildIcs([event]);
    expect(ics).toContain('dominant: Wind\\, Nuclear.');
  });

  it('emits one VEVENT per window', () => {
    const ics = buildIcs([event, { ...event, start: new Date('2026-06-18T03:00:00Z') }]);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });
});

describe('googleCalendarUrl', () => {
  it('builds a template link with the event window', () => {
    const url = googleCalendarUrl(event);
    expect(url).toContain('calendar.google.com');
    expect(url).toContain('action=TEMPLATE');
    expect(url).toContain('dates=20260617T020000Z%2F20260617T040000Z');
  });
});
