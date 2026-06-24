import { useState } from 'react';
import { useSeries } from './hooks/useSeries';
import { usePrice } from './hooks/usePrice';
import { NATIONAL, type RegionSelection } from './model/types';
import type { Baseline } from './engine/recommend';
import { FUEL_META, STACK_ORDER } from './model/fuels';
import Chart, { type ChartMode } from './components/Chart';
import Headline from './components/Headline';
import ScrubReadout from './components/ScrubReadout';
import CalendarExport from './components/CalendarExport';
import Footprint from './components/Footprint';
import Controls from './components/Controls';

export default function App() {
  const [region, setRegion] = useState<RegionSelection>(NATIONAL);
  const [mode, setMode] = useState<ChartMode>('change');
  const [baseline, setBaseline] = useState<Baseline>('now');
  const [horizon, setHorizon] = useState(24);
  const [cursorIndex, setCursorIndex] = useState<number | null>(null);
  const [showPrice, setShowPrice] = useState(false);

  const { series, monthlyAvg, loading, error } = useSeries(region);
  const { prices, gspLabel, error: priceError } = usePrice(region, showPrice);

  return (
    <main>
      <header className="app-header">
        <h1>Grid Clean</h1>
        <span className="region">
          {region.label}
          {region.postcode ? ` · ${region.postcode}` : ''}
        </span>
      </header>

      {loading && !series && <div className="status">Loading UK grid forecast…</div>}
      {error && !series && (
        <div className="status error">
          {error}
          <div className="footnote">The NESO Carbon Intensity API may be briefly unavailable.</div>
        </div>
      )}

      {series && (
        <>
          <Headline
            series={series}
            baseline={baseline}
            monthlyAvg={monthlyAvg}
            horizonHours={horizon}
          />
          <Controls
            mode={mode}
            setMode={setMode}
            baseline={baseline}
            setBaseline={setBaseline}
            horizon={horizon}
            setHorizon={setHorizon}
            region={region}
            setRegion={setRegion}
            showPrice={showPrice}
            setShowPrice={setShowPrice}
          />
          <div className="chart-card">
            <Chart
              series={series}
              mode={mode}
              baseline={baseline}
              monthlyAvg={monthlyAvg}
              prices={prices}
              cursorIndex={cursorIndex}
              onScrub={setCursorIndex}
              horizonHours={horizon}
            />
            {mode === 'mix' && (
              <div className="legend">
                {STACK_ORDER.slice()
                  .reverse()
                  .map((f) => (
                    <span key={f}>
                      <i style={{ background: FUEL_META[f].color }} />
                      {FUEL_META[f].label}
                    </span>
                  ))}
              </div>
            )}
          </div>
          <ScrubReadout
            series={series}
            cursorIndex={cursorIndex}
            baseline={baseline}
            monthlyAvg={monthlyAvg}
            prices={prices}
          />
          <Footprint />
          <CalendarExport series={series} />
          <div className="footnote">
            Data: NESO Carbon Intensity API · forecast refreshes ~every 30 min · all times local.
            {region.regionId === NATIONAL.regionId
              ? ' Forward mix from the GB regional forecast; hydro & other (which it omits) estimated from the same time last week.'
              : " Regional view: 12h history + forecast are NESO's regional estimate (no settled actuals)."}
            {mode === 'mix' &&
              region.regionId === NATIONAL.regionId &&
              ' Energy mix scaled to national demand (Elexon actuals + day-ahead forecast).'}
            {baseline === 'average' &&
              (monthlyAvg
                ? ` "Average" = ${region.label} 30-day, demand-weighted by GB load, ${Math.round(monthlyAvg.gco2)} gCO₂/kWh.`
                : ' Loading 30-day average…')}
            {showPrice &&
              (priceError
                ? ` Agile prices unavailable: ${priceError}`
                : ` Agile price (pink, right axis): ${gspLabel ?? '…'}; cost ≠ carbon, ~24h horizon so the line stops early.`)}
          </div>
        </>
      )}
    </main>
  );
}
