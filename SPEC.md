# UK Carbon-Aware Energy Forecast — Build Spec

A web app that shows a UK electricity carbon-intensity forecast and tells the user, in plain language backed by real numbers, when to use more electricity. Greenest now; cheapest is an optional later overlay.

Core principle: **simple to read, technically valid underneath.** Every plain-language claim must be anchored to a figure the user can reveal. The UI is layered — a glanceable headline, the forecast curve, then per-window and per-source detail on demand.

---

## 1. Scope and defaults

These are the assumed defaults. Each is a decision the user may want to revisit — see §7.

- **Platform:** mobile-first responsive web (the prototypes were designed at ~380px). Works on desktop too.
- **Geography:** national (GB) by default, with an optional postcode → regional view.
- **Signal:** carbon-first. Price (Octopus Agile) is an optional overlay, not in the MVP.
- **Horizon:** 48 hours forward (the working horizon of the documented forecast endpoints).
- **Backend:** none required for the MVP. All data sources below are public and the primary one is CORS-friendly, so a client-only app is viable. Add a thin serverless layer only if caching, an Elexon join, or CORS on a secondary source forces it.

---

## 2. Data sources

### 2.1 NESO Carbon Intensity API (primary, required)

Base: `https://api.carbonintensity.org.uk` — no auth, JSON, half-hourly slots, all times **UTC**. This is the backbone and is close to an MVP on its own: it already publishes a forecast *and* actuals, the categorical index, and the generation mix.

Key endpoints (confirm exact shapes against the live OpenAPI at build time, they occasionally add fields):

- `GET /intensity` — current national intensity: `forecast`, `actual`, `index` (very low → very high), in gCO₂/kWh.
- `GET /intensity/{fromISO}/fw48h` — forward 48h national forecast, half-hourly.
- `GET /intensity/{fromISO}/{toISO}` — historical/range (use for recent actuals to draw the "past tail").
- `GET /generation` — current national generation mix, `%` per fuel.
- `GET /generation/{fromISO}/{toISO}` — mix over a range.
- Regional (optional view): `GET /regional/postcode/{outcode}` (e.g. `S1`), `GET /regional/regionid/{id}`, and forward variants `GET /regional/intensity/{fromISO}/fw48h/postcode/{outcode}`. Regional responses bundle intensity **and** generation mix per DNO region.

Fuels returned: `biomass, coal, imports, gas, nuclear, other, hydro, solar, wind`.

Notes:
- The site advertises 96h+; the documented programmatic forward endpoints are `fw24h`/`fw48h`. Treat 48h as the reliable horizon and check whether a longer endpoint exists before promising more in the UI.
- This endpoint gives mix as **percentages only**, not absolute MW. For MW, use Elexon (§2.3).
- Poll roughly every 30 min and cache; the forecast refreshes on that cadence and actuals settle with a short lag.

### 2.2 Octopus Agile (optional — pricing overlay)

Base: `https://api.octopus.energy/v1` — tariff rates are public, **no key needed**.

- Discover the current Agile product code via `GET /products/` (it changes over time, e.g. an `AGILE-...` code — do not hardcode without checking).
- `GET /products/{product}/electricity-tariffs/E-1R-{product}-{REGION}/standard-unit-rates/?period_from={ISO}&period_to={ISO}` → half-hourly unit rates in p/kWh inc VAT. `{REGION}` is a single GSP-group letter A–P. Paginate via the `next` field for >2 days.
- Day-ahead rates publish ~16:00 UK. Forward horizon is ~24h, shorter than carbon's 48h — handle the mismatch in the UI (price line simply stops earlier).
- Needs a postcode → GSP-group-letter mapping. Cost and carbon broadly track but are not identical, so keep them as separate toggleable signals, never conflated.

### 2.3 Elexon Insights / BMRS (optional — absolute MW & validation)

Base: `https://data.elexon.co.uk/bmrs/api/v1` — public, **no key needed** (the old portal-key requirement is legacy).

- Generation by fuel type in MW: `GET /datasets/FUELINST` (≈5-min instantaneous) or `/datasets/FUELHH` (half-hourly). Confirm the exact dataset path/params at build time.
- Use for: (a) the "share vs output" toggle in the readout (§5.4), and (b) forecast-vs-actual validation (§6).

---

## 3. Internal data model

Normalise everything into one time-ordered series so the UI and logic never touch raw API shapes directly.

```ts
type Fuel = 'gas'|'coal'|'biomass'|'nuclear'|'hydro'|'wind'|'solar'|'imports'|'other';

interface Slot {
  ts: string;            // ISO UTC, start of the half-hour
  kind: 'actual' | 'forecast';
  gco2: number;          // gCO2/kWh (actual if available, else forecast)
  index: string;         // 'very low' … 'very high'
  mix: Record<Fuel, number>;   // share in %
  mw?: Record<Fuel, number>;   // absolute MW, only if Elexon joined
  price?: number;        // p/kWh, only if Octopus joined
}

interface Series {
  slots: Slot[];
  nowIndex: number;      // index of the current slot (latest actual / first forecast)
}
```

Build `slots` from a short tail of recent actuals (≈3h before now) concatenated with the 48h forward forecast. `nowIndex` is the boundary. Everything downstream keys off `slots` and `nowIndex`.

---

## 4. Recommendation engine (pure functions — the real work)

The app is **not** a forecaster; NESO already provides a skilled forecast. The engineering value is the decision layer on top. Implement these as pure, unit-tested functions with no UI dependency.

### 4.1 Relative framing
- `deltaVsNow(slot) = (slot.gco2 - now.gco2) / now.gco2`.
- `percentileToday(slot)` — rank within the forward window (default next 24h). Lets the UI say "cleanest 10% of today" so judgements stay honest across seasons (200 gCO₂ is great in winter, poor in summer).
- Baseline is switchable: **vs now** ("should I wait?") and **vs today's average** ("is this genuinely a good slot, regardless of the current moment?"). They answer different questions; support both.

### 4.2 Duration-aware window finder
Given a load duration `D` (in half-hour slots) and optional `earliestStart` / `deadline`:
- Slide a width-`D` window across the eligible forecast slots; for each, compute integrated carbon `sum(gco2_i)`.
- Return the start that minimises it (the cleanest window), plus the "run it now" integrated carbon and the resulting % saving.
- Generalise to top-k non-overlapping windows.
- Expose presets: dishwasher ≈ 1.5h, washing machine ≈ 2h, EV charge ≈ 4–6h.
- O(n) sliding sum; the care is in slot-boundary handling, missing data, and deadlines.

This is the step that turns the chart from decorative into an actual optimiser, and it maps cleanly onto "cuts that display the best times."

### 4.3 Window classification (the "cuts")
- **Recommended** windows: contiguous runs below today's 25th percentile, of at least some minimum length.
- **Avoid** windows: runs above the 75th percentile.
- Each carries: time range, mean gCO₂, `deltaVsNow`, dominant fuels, suggested loads.

### 4.4 Per-source delta vs now
For any slot and each fuel: `mix_slot - mix_now` in percentage points (and `mw_slot - mw_now` if Elexon joined). This powers the scrub readout (§5.4).

### 4.5 Messaging
Generate grounded one-liners bound to a number — "Greener than usual: wind ~45% of the grid" beats "great time to go green." Keep a small template set keyed off the values; never rely on colour alone to carry meaning.

---

## 5. UI / display spec

The prototype this is based on is the target. Build the chart as a **bespoke SVG (or Canvas) component**, not a charting library — the diverging fill, now-anchor, and scrub interaction are all custom and fight off-the-shelf charts. Keep it flat, accessible, and dark-mode-correct.

### 5.1 The "now" anchor (decided)
`now` carries two meanings and gets **one anchor** for both:
- **Time:** a vertical divider on the x-axis. Recent actuals run to its left as a muted/dashed tail; the forecast runs solid to its right. A small "Now" pill sits at the top of the divider.
- **Level:** a horizontal dashed baseline at the current gCO₂, which is what the diverging fill measures against. It **emanates from the now dot** (the intersection of the vertical divider and the curve), so "this moment" and "this carbon level" meet at one labelled point.

### 5.2 Diverging "vs now" fill (decided)
Fill the area between the forecast curve and the now-level baseline: **green where the grid is cleaner than now, amber where dirtier.** Apply this only to the **future** side — the past is context, not a choice, so it is not coloured as if it were one.

### 5.3 Mode toggle
- **Change vs now** — the diverging fill above.
- **Energy mix** — a stacked area of generation share over the same axis, so the user sees *why* a dip is clean (wind) or a spike dirty (gas). Keep the intensity line overlaid in both modes for continuity.

### 5.4 Scrub / hover readout (decided)
Dragging across the plot (pointer events; works for touch and mouse) moves a guide line and updates a readout panel that lives in normal flow below the chart (not a floating tooltip):
- Header: time · gCO₂ · delta vs now.
- One row per fuel: a bar filled to that fuel's share at the cursor, with a **tick marking the same fuel's share right now** — the gap is the visual "how different from now." A signed number repeats it precisely, **coloured by carbon direction** (green when the shift helps — more wind/solar/nuclear or less gas/imports — red when it hurts), independent of the raw sign.
- If the cursor is inside a recommended/avoid window, append the suggested-load line.
- Resting state is `now`, where all deltas are zero by definition.
- Desktop should additionally support true hover-follow (same handler on `pointermove` without the press-gate).

### 5.5 Best-window list ("cuts")
A short vertical list of the recommended windows plus the one "avoid" window, each showing range, mean gCO₂, and delta. Tapping one scrubs the chart to that window and updates the readout.

### 5.6 Secondary
- Baseline toggle (vs now / vs today average).
- Region selector (postcode → DNO region) switching the series to regional data.
- Horizon control (24h / 48h); for any longer view, collapse to a day-level summary rather than rendering half-hourly across days on a phone.
- Optional price line if Octopus is wired in (note its shorter horizon).

---

## 6. Validation

- **Forecast skill:** once actuals settle, compute MAE in gCO₂ between forecast and actual.
- **Decision skill (the one users feel):** did a recommended window actually land in the cleanest quartile of the realised actuals? Track this over time — it is the metric that matters more than raw MAE.

---

## 7. Open decisions to surface (with recommended defaults)

Don't silently guess these — confirm with the user, but proceed on the default if unanswered.

1. **National vs regional default** — default national, postcode optional.
2. **Pricing** — default carbon-only MVP; add Octopus as an overlay later.
3. **Share vs absolute MW** — the per-source delta is currently in mix *percentage points*, which is honest but can mislead: a fuel's share can rise simply because total demand fell, not because more of it is generating. Default to share; if Elexon MW is joined, add a "share vs output" toggle.
4. **Horizon** — default 48h; day-collapsed beyond that.
5. **Hover vs scrub** — scrub on touch, hover-follow on desktop.

---

## 8. Suggested stack and build order

**Stack:** Vite + React + TypeScript, client-only for the MVP (the carbon API is CORS-friendly). Typed data-client module per source with in-memory + localStorage caching on the 30-min cadence. Bespoke SVG chart component. Light state (hooks/context; no heavy store needed). Add a Cloudflare Worker / Vercel function later only if you need server-side caching, an Elexon join, or to proxy a non-CORS source.

**Order:**
1. Carbon API data client (current + `fw48h` + generation), typed and cached. Verify endpoints live first.
2. Normalise into `Series` with `nowIndex` (recent actuals tail + forecast).
3. Recommendation engine (§4) as pure functions + unit tests — build and test this *before* the UI.
4. Chart component: now-anchor, past/future split, future-only diverging fill, recommended/avoid bands.
5. Scrub readout with per-source deltas.
6. Best-window list + duration-aware finder UI.
7. Mix mode, baseline toggle, region selector.
8. Optional: Octopus price overlay; Elexon MW + share-vs-output toggle; desktop hover-follow; day-collapsed long horizon.

---

## 9. Reference

- NESO Carbon Intensity API docs / OpenAPI: the canonical definitions site (verify current paths there).
- Octopus developer docs: `https://developer.octopus.energy/`
- Elexon Insights developer portal: `https://developer.data.elexon.co.uk/`
