import type { MonthlyAverage, Series } from '../model/types';
import { headlineMessage, type Baseline } from '../engine/recommend';

const INDEX_COLORS: Record<string, string> = {
  'very low': '#16a34a',
  low: '#22c55e',
  moderate: '#eab308',
  high: '#b45309',
  'very high': '#92400e',
};

interface Props {
  series: Series;
  baseline: Baseline;
  monthlyAvg: MonthlyAverage | null;
  horizonHours: number;
}

export default function Headline({ series, baseline, monthlyAvg, horizonHours }: Props) {
  const now = series.slots[series.nowIndex];
  const msg = headlineMessage(series, baseline, monthlyAvg, horizonHours);
  const color = INDEX_COLORS[now.index] ?? 'var(--neutral)';

  return (
    <div className="headline">
      <span className="index-pill" style={{ background: color, color: '#0d1117' }}>
        {now.index} · {Math.round(now.gco2)} g
      </span>
      <div className={`big tone-${msg.tone}`}>{msg.text}</div>
      <div className="figure">{msg.figure}</div>
    </div>
  );
}
