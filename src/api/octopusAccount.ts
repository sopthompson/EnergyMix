// Authenticated Octopus account access for a user's own consumption (SPEC §9
// extension). HTTP Basic with the API key as the username (no password).
//
// LOCAL USE ONLY: the API key is the user's secret and here it lives in the
// browser. This module is deliberately isolated so that, when the app is
// launched as a website, these calls move behind a backend that holds the key —
// the pure footprint compute (see ../footprint/compute) does not change.

const BASE = 'https://api.octopus.energy/v1';

export interface MeterRef {
  mpan: string;
  serial: string;
}

export interface GasMeterRef {
  mprn: string;
  serial: string;
}

interface AccountResponse {
  properties: Array<{
    electricity_meter_points?: Array<{
      mpan: string;
      is_export?: boolean;
      meters?: Array<{ serial_number: string }>;
    }>;
    gas_meter_points?: Array<{
      mprn: string;
      meters?: Array<{ serial_number: string }>;
    }>;
  }>;
}

interface ConsumptionResponse {
  next: string | null;
  results: Array<{ consumption: number; interval_start: string }>;
}

function authHeader(apiKey: string): Record<string, string> {
  // btoa is available in browsers and Node ≥16.
  return { Authorization: `Basic ${btoa(`${apiKey}:`)}`, Accept: 'application/json' };
}

async function getJson<T>(url: string, apiKey: string): Promise<T> {
  const res = await fetch(url, { headers: authHeader(apiKey) });
  if (res.status === 401) throw new Error('Octopus rejected the API key (401).');
  if (!res.ok) throw new Error(`Octopus ${res.status}`);
  return (await res.json()) as T;
}

/**
 * All import electricity meters (MPAN + serial) on an account. A meter point can
 * hold several serials over time — e.g. a SMETS2 meter is re-commissioned when a
 * paired gas smart meter is fitted, producing a new serial from that date — so
 * every serial must be read to get the full consumption history.
 */
export async function getElectricityMeters(apiKey: string, account: string): Promise<MeterRef[]> {
  const json = await getJson<AccountResponse>(`${BASE}/accounts/${account.trim()}/`, apiKey);
  const out: MeterRef[] = [];
  for (const prop of json.properties ?? []) {
    for (const mp of prop.electricity_meter_points ?? []) {
      if (mp.is_export) continue;
      for (const m of mp.meters ?? []) out.push({ mpan: mp.mpan, serial: m.serial_number });
    }
  }
  if (!out.length) throw new Error('No import electricity meter found on this account.');
  return out;
}

async function fetchConsumption(firstUrl: string, apiKey: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let url: string | null = firstUrl;
  let pages = 0;
  while (url && pages < 30) {
    const json: ConsumptionResponse = await getJson(url, apiKey);
    for (const r of json.results) out.set(r.interval_start.slice(0, 16), r.consumption);
    url = json.next;
    pages++;
  }
  return out;
}

/**
 * Half-hourly electricity consumption (kWh) over [from, to], keyed by
 * minute-precision interval start. Follows pagination.
 */
export async function getConsumption(
  apiKey: string,
  meter: MeterRef,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  return fetchConsumption(
    `${BASE}/electricity-meter-points/${meter.mpan}/meters/${meter.serial}/consumption/?period_from=${from.toISOString()}&period_to=${to.toISOString()}&page_size=25000&order_by=period`,
    apiKey,
  );
}

/** All gas meters (MPRN + serial) on an account. */
export async function getGasMeters(apiKey: string, account: string): Promise<GasMeterRef[]> {
  const json = await getJson<AccountResponse>(`${BASE}/accounts/${account.trim()}/`, apiKey);
  const out: GasMeterRef[] = [];
  for (const prop of json.properties ?? []) {
    for (const mp of prop.gas_meter_points ?? []) {
      for (const m of mp.meters ?? []) out.push({ mprn: mp.mprn, serial: m.serial_number });
    }
  }
  return out;
}

/**
 * Daily gas consumption over [from, to], keyed by day. Units are the meter's
 * native unit (m³ for most smart meters, kWh for some) — the caller converts.
 * Grouped by day since gas's emission factor is flat (no half-hourly needed).
 */
export async function getGasConsumption(
  apiKey: string,
  meter: GasMeterRef,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  return fetchConsumption(
    `${BASE}/gas-meter-points/${meter.mprn}/meters/${meter.serial}/consumption/?period_from=${from.toISOString()}&period_to=${to.toISOString()}&page_size=25000&group_by=day&order_by=period`,
    apiKey,
  );
}
