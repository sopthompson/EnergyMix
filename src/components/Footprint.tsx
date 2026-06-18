import { useState } from 'react';
import { gspRegionLabel } from '../model/gsp';
import { calculateFootprint, type FullFootprint } from '../footprint/run';
import type { IntensityBasis } from '../footprint/intensity';
import type { FootprintPeriod, GasPeriod, GasUnit } from '../footprint/compute';

const REGION_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function fmtKg(kg: number): string {
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${Math.round(kg)} kg`;
}
function fmtDate(ts: string | null): string {
  return ts
    ? new Date(`${ts}:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';
}

function ElecCard({ p }: { p: FootprintPeriod }) {
  if (!p.slots) {
    return (
      <div className="fp-card">
        <div className="fp-card-label">Electricity · {p.label}</div>
        <div className="fp-sub">No data in this period.</div>
      </div>
    );
  }
  const diff = Math.round(((p.yourIntensity - p.gridAvgIntensity) / p.gridAvgIntensity) * 100);
  const good = diff <= 0;
  return (
    <div className="fp-card">
      <div className="fp-card-label">⚡ Electricity · {p.label}</div>
      <div className="fp-big">{fmtKg(p.kgCo2)} CO₂</div>
      <div className="fp-sub">
        {Math.round(p.kwh).toLocaleString()} kWh · {fmtDate(p.fromTs)} → {fmtDate(p.toTs)}
      </div>
      <div className="fp-intensity" style={{ color: good ? 'var(--good)' : 'var(--bad)' }}>
        Your timing: {Math.round(p.yourIntensity)} vs {Math.round(p.gridAvgIntensity)} g grid avg (
        {diff > 0 ? `+${diff}` : diff}%)
      </div>
    </div>
  );
}

function GasCard({ p }: { p: GasPeriod }) {
  if (!p.kwh) {
    return (
      <div className="fp-card">
        <div className="fp-card-label">🔥 Gas · {p.label}</div>
        <div className="fp-sub">No data in this period.</div>
      </div>
    );
  }
  return (
    <div className="fp-card">
      <div className="fp-card-label">🔥 Gas · {p.label}</div>
      <div className="fp-big">{fmtKg(p.kgCo2)} CO₂</div>
      <div className="fp-sub">
        {Math.round(p.kwh).toLocaleString()} kWh · {fmtDate(p.fromTs)} → {fmtDate(p.toTs)}
      </div>
    </div>
  );
}

export default function Footprint() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('caf:octo-key') ?? '');
  const [account, setAccount] = useState(() => localStorage.getItem('caf:octo-acct') ?? '');
  const [basisRegion, setBasisRegion] = useState(0); // 0 = UK-wide
  const [gasUnit, setGasUnit] = useState<GasUnit>('m3');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<FullFootprint | null>(null);

  async function run() {
    setError('');
    setResult(null);
    setBusy(true);
    localStorage.setItem('caf:octo-key', apiKey);
    localStorage.setItem('caf:octo-acct', account);
    const basis: IntensityBasis =
      basisRegion === 0 ? { kind: 'national' } : { kind: 'regional', regionId: basisRegion };
    try {
      const r = await calculateFootprint({ apiKey, account, basis, gasUnit }, setStatus);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Calculation failed');
    } finally {
      setBusy(false);
      setStatus('');
    }
  }

  const combined = result
    ? {
        recent: result.electricity.lastYear.kgCo2 + (result.gas?.lastYear.kgCo2 ?? 0),
        lifetime: result.electricity.lifetime.kgCo2 + (result.gas?.lifetime.kgCo2 ?? 0),
      }
    : null;

  return (
    <details className="fp">
      <summary>Your carbon footprint (Octopus account)</summary>
      <div className="fp-body">
        <div className="fp-inputs">
          <input
            type="password"
            placeholder="Octopus API key (sk_live_…)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <input
            placeholder="Account number (A-XXXXXXXX)"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            autoComplete="off"
          />
          <select aria-label="Grid basis" value={basisRegion} onChange={(e) => setBasisRegion(Number(e.target.value))}>
            <option value={0}>Electricity grid: UK-wide (recommended)</option>
            {REGION_IDS.map((id) => (
              <option key={id} value={id}>
                Electricity grid: {gspRegionLabel(id)}
              </option>
            ))}
          </select>
          <select aria-label="Gas unit" value={gasUnit} onChange={(e) => setGasUnit(e.target.value as GasUnit)}>
            <option value="m3">Gas meter reads in m³ (most smart meters)</option>
            <option value="kwh">Gas meter reads in kWh</option>
          </select>
          <button className="cal-btn" disabled={busy || !apiKey || !account} onClick={run}>
            {busy ? status || 'Working…' : 'Calculate my footprint'}
          </button>
        </div>

        {error && <div className="fp-error">{error}</div>}

        {result && (
          <div className="fp-results">
            {combined && (
              <div className="fp-card" style={{ borderLeft: '3px solid var(--good)' }}>
                <div className="fp-card-label">Combined (electricity + gas)</div>
                <div className="fp-big">{fmtKg(combined.recent)} CO₂</div>
                <div className="fp-sub">
                  most recent 12 months · {fmtKg(combined.lifetime)} since earliest reading
                </div>
              </div>
            )}
            <ElecCard p={result.electricity.lastYear} />
            <ElecCard p={result.electricity.lifetime} />
            {result.gas && (
              <>
                <GasCard p={result.gas.lastYear} />
                <GasCard p={result.gas.lifetime} />
              </>
            )}
          </div>
        )}

        <details className="fp-method">
          <summary>Data &amp; method</summary>
          <p>
            Electricity = your half-hourly usage × the grid's carbon intensity at each moment
            (UK-wide settled actuals, or your region's NESO estimate if selected). Gas = your usage ×
            a fixed factor of 0.183 kgCO₂/kWh (UK DEFRA/BEIS natural-gas factor). A lower electricity
            "timing" figure than the grid average means you use power at cleaner times.
          </p>
          <p>
            Privacy: your API key and account number stay in this browser (localStorage) — data is
            fetched only from Octopus and NESO, never sent anywhere else.
          </p>
        </details>
      </div>
    </details>
  );
}
