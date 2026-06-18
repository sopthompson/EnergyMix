// Octopus Agile tariff client (SPEC §2.2). Public, no key, CORS-friendly
// (verified: access-control-allow-origin: *). Half-hourly unit rates in p/kWh
// inc VAT. Cost is kept entirely separate from carbon — never conflated.

import { readCache, writeCache } from './cache';

const BASE = 'https://api.octopus.energy/v1';
const PRODUCT_TTL = 24 * 60 * 60 * 1000; // the Agile product code changes rarely
const RATES_TTL = 30 * 60 * 1000;

interface Product {
  code: string;
  direction: string;
  brand: string;
  available_from: string | null;
}

interface RatePeriod {
  value_inc_vat: number;
  valid_from: string;
  valid_to: string;
}

async function getJson<T>(url: string, ttl: number): Promise<T> {
  const cached = readCache<T>(url, ttl);
  if (cached !== undefined) return cached;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Octopus ${res.status} for ${url}`);
  const json = (await res.json()) as T;
  writeCache(url, json);
  return json;
}

/** Discover the current Agile import product code (do not hardcode — it rotates). */
export async function getCurrentAgileProduct(): Promise<string> {
  const json = await getJson<{ results: Product[] }>(`${BASE}/products/`, PRODUCT_TTL);
  const agile = json.results
    .filter(
      (p) =>
        p.code.startsWith('AGILE') &&
        p.direction === 'IMPORT' &&
        p.brand === 'OCTOPUS_ENERGY',
    )
    .sort((a, b) => (a.available_from ?? '').localeCompare(b.available_from ?? ''));
  if (!agile.length) throw new Error('No current Agile product found');
  return agile[agile.length - 1].code;
}

/**
 * Half-hourly Agile unit rates (p/kWh inc VAT) for a GSP group letter over
 * [from, to], keyed by minute-precision timestamp. Follows pagination.
 */
export async function getAgileRates(
  gspLetter: string,
  from: Date,
  to: Date,
): Promise<Map<string, number>> {
  const product = await getCurrentAgileProduct();
  const tariff = `E-1R-${product}-${gspLetter}`;
  let url:
    | string
    | null = `${BASE}/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/?period_from=${from.toISOString()}&period_to=${to.toISOString()}&page_size=300`;

  const out = new Map<string, number>();
  let pages = 0;
  while (url && pages < 5) {
    const json: { results: RatePeriod[]; next: string | null } = await getJson(url, RATES_TTL);
    for (const r of json.results) {
      out.set(r.valid_from.slice(0, 16), r.value_inc_vat);
    }
    url = json.next;
    pages++;
  }
  return out;
}
