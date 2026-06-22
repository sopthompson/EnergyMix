// Generates a static iCalendar feed of the cleanest 2h power window for each of
// the next few days, for the GitHub Pages site. Run in CI (on a schedule) so the
// published .ics refreshes and calendar apps that subscribe to it re-poll fresh
// windows — a subscribable feed with no server.
//
// Usage: node scripts/generate-calendar.mjs [outPath]   (default: dist/calendar.ics)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CI = 'https://api.carbonintensity.org.uk';
const BEST_WINDOW_SLOTS = 4; // 2h
const SLOT_MS = 30 * 60 * 1000;

const FUEL_LABEL = {
  gas: 'Gas', coal: 'Coal', biomass: 'Biomass', nuclear: 'Nuclear', hydro: 'Hydro',
  wind: 'Wind', solar: 'Solar', imports: 'Imports', other: 'Other',
};

const toApiTime = (d) => d.toISOString().slice(0, 16) + 'Z';
const toUtc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
const londonDay = (iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(iso));

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Cleanest width-D window (lowest mean gCO₂) within a day's slots.
function bestWindow(daySlots) {
  if (daySlots.length < BEST_WINDOW_SLOTS) return null;
  let best = null;
  for (let i = 0; i + BEST_WINDOW_SLOTS <= daySlots.length; i++) {
    const slice = daySlots.slice(i, i + BEST_WINDOW_SLOTS);
    const sum = slice.reduce((a, s) => a + s.gco2, 0);
    if (!best || sum < best.sum) best = { sum, slice };
  }
  const mean = best.sum / BEST_WINDOW_SLOTS;
  const start = best.slice[0].from;
  const end = new Date(Date.parse(best.slice[best.slice.length - 1].from) + SLOT_MS).toISOString();
  return { start, end, mean, slots: best.slice };
}

function dominantFuels(slots, mixByTs) {
  const totals = {};
  for (const s of slots) {
    const mix = mixByTs.get(s.from.slice(0, 16)) || {};
    for (const [f, v] of Object.entries(mix)) totals[f] = (totals[f] || 0) + v;
  }
  return Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([f]) => FUEL_LABEL[f] || f);
}

function buildIcs(events) {
  const stamp = toUtc(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Grid Clean//Carbon Forecast//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Grid Clean — cleanest power windows',
    'X-PUBLISHED-TTL:PT6H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:clean-${e.dayKey}@energymix`, // stable per day so updates replace, not duplicate
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

async function main() {
  const out = process.argv[2] || 'dist/calendar.ics';
  let events = [];
  try {
    const now = new Date();
    const [natl, regional] = await Promise.all([
      getJson(`${CI}/intensity/${toApiTime(now)}/fw48h`),
      getJson(`${CI}/regional/intensity/${toApiTime(now)}/fw48h/regionid/18`),
    ]);
    const slots = natl.data
      .map((p) => ({ from: p.from, gco2: p.intensity.actual ?? p.intensity.forecast }))
      .filter((s) => s.gco2 != null);
    const mixByTs = new Map();
    for (const p of regional.data.data) {
      mixByTs.set(p.from.slice(0, 16), Object.fromEntries(p.generationmix.map((g) => [g.fuel, g.perc])));
    }

    const byDay = new Map();
    for (const s of slots) {
      const k = londonDay(s.from);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(s);
    }

    // Tomorrow = the next full local day ([0] is today, partial). Pinning to it
    // keeps the subscribed event stable instead of shifting on every refresh.
    const days = [...byDay];
    const tomorrow = days[1];
    if (tomorrow) {
      const [dayKey, daySlots] = tomorrow;
      const w = bestWindow(daySlots);
      if (w) {
        const fuels = dominantFuels(w.slots, mixByTs).join(' + ');
        events.push({
          dayKey: dayKey.replace(/-/g, ''),
          start: w.start,
          end: w.end,
          title: `Cleanest power · ${Math.round(w.mean)} gCO₂/kWh`,
          description:
            `Greenest 2h window tomorrow to run heavy appliances (dishwasher, washing, EV charge). ` +
            `Mean ${Math.round(w.mean)} gCO₂/kWh. Dominant: ${fuels}. ` +
            `Source: NESO Carbon Intensity via Grid Clean.`,
        });
      }
    }
    console.log(`Generated ${events.length} window event(s).`);
  } catch (err) {
    // Stay resilient: publish a valid (empty) calendar so the feed URL never 404s.
    console.error('Calendar generation failed, writing empty feed:', err.message);
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, buildIcs(events));
  console.log(`Wrote ${out}`);
}

main();
