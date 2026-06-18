// Two-tier cache: in-memory for the session, localStorage so a reload within
// the 30-min cadence (SPEC §2.1) doesn't re-hit the API. Each entry is keyed by
// request URL and stamped with a fetch time; callers pass a max age.

interface Entry<T> {
  at: number; // epoch ms
  value: T;
}

const PREFIX = 'caf:'; // carbon-aware-forecast
const memory = new Map<string, Entry<unknown>>();

function lsKey(key: string) {
  return PREFIX + key;
}

export function readCache<T>(key: string, maxAgeMs: number): T | undefined {
  const now = Date.now();
  const mem = memory.get(key) as Entry<T> | undefined;
  if (mem && now - mem.at <= maxAgeMs) return mem.value;

  try {
    const raw = localStorage.getItem(lsKey(key));
    if (raw) {
      const parsed = JSON.parse(raw) as Entry<T>;
      if (now - parsed.at <= maxAgeMs) {
        memory.set(key, parsed);
        return parsed.value;
      }
    }
  } catch {
    // localStorage may be unavailable (private mode, SSR); fall through.
  }
  return undefined;
}

export function writeCache<T>(key: string, value: T): void {
  const entry: Entry<T> = { at: Date.now(), value };
  memory.set(key, entry);
  try {
    localStorage.setItem(lsKey(key), JSON.stringify(entry));
  } catch {
    // Ignore quota / unavailability; memory cache still serves the session.
  }
}
