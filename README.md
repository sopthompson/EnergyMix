# Grid Clean — UK Carbon-Aware Energy Forecast

A mobile-first web app that shows the UK electricity carbon-intensity forecast and
tells you, in plain language backed by real numbers, when to use more power.
Greenest-now is the default signal; pricing is a planned later overlay.

Built to [`SPEC.md`](./SPEC.md). Carbon-first MVP, client-only (no backend).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine + series-assembly unit tests (Vitest)
npm run build      # typecheck + production bundle
```

Requires Node 18+ (developed on Node 26).

## What it does

- **Headline** — a glanceable, grounded verdict ("Good time to use power now…")
  bound to the live figure, never colour alone.
- **Bespoke SVG chart** — a single "now" anchor (vertical time divider + horizontal
  level baseline meeting at the now dot), a muted dashed actual tail to the left and
  the solid forecast to the right, with a future-only diverging fill: green where the
  grid will be cleaner than now, amber where dirtier.
- **Two modes** — *Change vs now* (the diverging fill) and *Energy mix* (a stacked
  area of generation share), with the intensity line overlaid in both.
- **Scrub readout** — drag (touch) or hover (desktop) to move a guide line; a panel
  below the chart shows time · gCO₂ · delta vs now, then one bar per fuel filled to
  the cursor's share with a tick marking the share *right now*. The signed delta is
  coloured by carbon direction (green when the shift helps, red when it hurts),
  independent of raw sign.
- **Best-window list** — recommended windows plus the one worst "avoid" window;
  tap one to scrub the chart to it.
- **Controls** — baseline (vs now / vs today's average), horizon (24h / 48h), and a
  region selector by DNO region or postcode.

## Architecture

```
src/
  api/carbon.ts        Typed NESO Carbon Intensity client + 30-min cache
  api/cache.ts         Memory + localStorage cache
  model/types.ts       Slot / Series internal model (SPEC §3)
  model/fuels.ts       Fuel metadata + carbon direction
  model/buildSeries.ts Normalise API responses into one Series with nowIndex
  engine/recommend.ts  Pure decision functions (SPEC §4) — unit-tested
  components/          Chart, Headline, ScrubReadout, WindowList, Controls
  hooks/useSeries.ts   Fetch + poll on the 30-min cadence
```

### Data sources (SPEC §2)

`api.carbonintensity.org.uk` only (no auth, CORS-friendly, all times UTC):

- National `fw48h` intensity — authoritative actuals + forecast, drives the line.
- National `generation/{from}/{to}` — the actual tail's true generation mix.
- GB regional forecast (`regionid/18`) — the only public source of a **forward**
  generation mix; this is how the mix mode and per-source deltas work into the future.
- Regional/postcode endpoints power the region selector (regional views are
  forecast-only, with `now` at the first slot).

Octopus Agile pricing and Elexon MW (share-vs-output) are intentionally out of the
MVP; the `Slot` model already carries optional `price` and `mw` fields for them.

### Decision engine (`engine/recommend.ts`)

Pure, UI-free, and unit-tested before the UI was built:

- `deltaVsNow`, `percentileToday`, switchable baseline (now / today average).
- `findBestWindow` / `findTopWindows` — O(n) sliding-sum duration-aware finder with
  `earliestStart` / `deadline` constraints and non-overlapping top-k.
- `classifyWindows` — contiguous runs below p25 (recommended) / above p75 (avoid).
- `perSourceDelta` — per-fuel mix delta vs now, coloured by carbon direction.
- `headlineMessage` / `slotMessage` — grounded one-liners bound to a figure.

## Deploy (GitHub Pages)

Static, client-only — safe to host publicly:

- **No server-side secrets.** NESO, Octopus tariff, and Elexon are all keyless public
  APIs. The only credential is a visitor's own Octopus API key in the footprint tool,
  which is stored only in their browser (`localStorage`) and sent only to Octopus over
  HTTPS — never to this repo or any server.
- `vite.config.ts` uses a **relative base** on build, so the bundle works at
  `https://<user>.github.io/<repo>/` without hardcoding the repo name.
- `.github/workflows/deploy.yml` builds, runs the tests, and publishes `dist/` on every
  push to `main` (least-privilege token; `pages: write` + OIDC only).

First-time setup:

```bash
git push -u origin main          # push to your new GitHub repo
```

Then in the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
The workflow runs on push; the live URL appears in the Actions run and under Settings → Pages.

## Notes & limits

- Forecast horizon is 48h (the documented reliable endpoint); the UI caps at 48h.
- Regional views use NESO's regional *estimate* for both the 12h tail and the forecast
  (no settled per-region actuals exist).
- The forward mix for the national view comes from the GB *regional* model, so its
  intensity differs slightly from the national line; the national line stays
  authoritative and the regional mix is used only for the shares. Forecast hydro/other
  are estimated from the same time last week (NESO omits them forward).
- The 30-day "average" baseline is demand-weighted; for a DNO region it weights the
  regional intensity by the national demand profile (no per-region MW feed exists).
