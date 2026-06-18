import { useEffect, useState } from 'react';
import type { ChartMode } from './Chart';
import type { Baseline } from '../engine/recommend';
import { NATIONAL, type RegionSelection } from '../model/types';
import { getRegions, type RegionInfo } from '../api/carbon';

interface Props {
  mode: ChartMode;
  setMode: (m: ChartMode) => void;
  baseline: Baseline;
  setBaseline: (b: Baseline) => void;
  horizon: number;
  setHorizon: (h: number) => void;
  region: RegionSelection;
  setRegion: (r: RegionSelection) => void;
  showPrice: boolean;
  setShowPrice: (v: boolean) => void;
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function Controls({
  mode,
  setMode,
  baseline,
  setBaseline,
  horizon,
  setHorizon,
  region,
  setRegion,
  showPrice,
  setShowPrice,
}: Props) {
  const [regions, setRegions] = useState<RegionInfo[]>([]);

  useEffect(() => {
    getRegions()
      .then(setRegions)
      .catch(() => setRegions([]));
  }, []);

  return (
    <>
      <div className="toggle-row">
        <Segmented<ChartMode>
          label="Chart mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'change', label: 'Change vs now' },
            { value: 'mix', label: 'Energy mix' },
          ]}
        />
        <Segmented<number>
          label="Horizon"
          value={horizon}
          onChange={setHorizon}
          options={[
            { value: 24, label: '24h' },
            { value: 48, label: '48h' },
          ]}
        />
        <div className="segmented" role="group" aria-label="Price overlay">
          <button aria-pressed={showPrice} onClick={() => setShowPrice(!showPrice)}>
            ₤ Agile price
          </button>
        </div>
      </div>
      <div className="toggle-row">
        <Segmented<Baseline>
          label="Baseline"
          value={baseline}
          onChange={setBaseline}
          options={[
            { value: 'now', label: 'vs now' },
            { value: 'average', label: 'vs average' },
          ]}
        />
        <div className="field">
          <select
            aria-label="Region"
            value={region.regionId}
            onChange={(e) => {
              const id = Number(e.target.value);
              if (id === NATIONAL.regionId) setRegion(NATIONAL);
              else {
                const info = regions.find((r) => r.regionid === id);
                setRegion({ regionId: id, label: info?.shortname ?? `Region ${id}` });
              }
            }}
          >
            <option value={NATIONAL.regionId}>Great Britain</option>
            {regions
              .filter((r) => r.regionid <= 14)
              .map((r) => (
                <option key={r.regionid} value={r.regionid}>
                  {r.shortname}
                </option>
              ))}
          </select>
        </div>
      </div>
    </>
  );
}
