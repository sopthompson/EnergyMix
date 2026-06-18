import type { MonthlyAverage, Series } from '../model/types';
import { FUEL_META, STACK_ORDER } from '../model/fuels';
import { deltaVsValue, nowSlot, perSourceDelta, type Baseline } from '../engine/recommend';

interface Props {
  series: Series;
  cursorIndex: number | null;
  baseline: Baseline;
  monthlyAvg: MonthlyAverage | null;
  prices: Map<string, number> | null;
}

function signed(n: number, digits = 0): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : v;
}

// Per-fuel bar: the cursor's share is filled, a tick marks the reference share
// (now, or the 30-day average), and the signed delta is coloured green/brown by
// carbon direction. Numbers carry the magnitude — no prose (SPEC §5.4).
export default function ScrubReadout({
  series,
  cursorIndex,
  baseline,
  monthlyAvg,
  prices,
}: Props) {
  const idx = cursorIndex ?? series.nowIndex; // resting state is now
  const slot = series.slots[idx];
  const now = nowSlot(series);
  const price = prices?.get(slot.ts.slice(0, 16));

  // Reference: the 30-day average when that baseline is selected and loaded,
  // otherwise the current moment.
  const useAvg = baseline === 'average' && !!monthlyAvg;
  const refGco2 = useAvg ? monthlyAvg!.gco2 : now.gco2;
  const refMix = useAvg ? monthlyAvg!.mix : now.mix;
  const refLabel = useAvg ? 'vs 30-day avg' : 'vs now';
  // In vs-now mode the now slot is the zero-delta resting point; in vs-average
  // mode even "now" carries a delta against the average.
  const restingZero = !useAvg && idx === series.nowIndex;

  const delta = deltaVsValue(slot.gco2, refGco2);
  const deltas = perSourceDelta(series, slot, refMix);
  const byFuel = Object.fromEntries(deltas.map((d) => [d.fuel, d]));
  const deltaColor = delta < 0 ? 'var(--good)' : 'var(--bad)';

  return (
    <div className="readout">
      <div className="readout-head">
        <span className="time">
          {new Date(slot.ts).toLocaleString('en-GB', {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
        <span className="gco2">
          {Math.round(slot.gco2)} gCO₂/kWh
          {price != null && (
            <span style={{ color: 'var(--price)', marginLeft: 8 }}>
              {price < 0 ? '−' : ''}
              {Math.abs(price).toFixed(1)}p
            </span>
          )}
        </span>
      </div>
      {!restingZero && (
        <div className="readout-delta" style={{ color: deltaColor }}>
          {signed(delta * 100)}% {refLabel}
        </div>
      )}

      <div className="fuel-rows">
        {STACK_ORDER.slice()
          .reverse()
          .map((fuel) => {
            const d = byFuel[fuel];
            const share = slot.mix[fuel];
            const meta = FUEL_META[fuel];
            const color =
              d.helpful > 0 ? 'var(--good)' : d.helpful < 0 ? 'var(--bad)' : 'var(--text-faint)';
            return (
              <div className="fuel-row" key={fuel}>
                <span className="name">{meta.label}</span>
                <span className="fuel-bar">
                  <span
                    className="fill"
                    style={{ width: `${Math.min(100, share)}%`, background: meta.color }}
                  />
                  <span className="now-tick" style={{ left: `${Math.min(100, d.refShare)}%` }} />
                </span>
                <span
                  className="fuel-delta"
                  style={{
                    color: restingZero || Math.abs(d.deltaPp) < 0.05 ? 'var(--text-faint)' : color,
                  }}
                >
                  {restingZero ? `${Math.round(share)}%` : `${signed(d.deltaPp, 1)}`}
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}
