// Place search and live typeahead suggestions (Google Places API / Photon / Nominatim).
const ENDPOINT = typeof window !== 'undefined' ? '/api/search' : 'https://nominatim.openstreetmap.org/search';
const MIN_GAP_MS = 1100;
const cache = new Map();
let queue = Promise.resolve();
let lastStart = 0;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function enqueue(task) {
  const run = async () => {
    const wait = lastStart + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return task();
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

/** Formal place search (used on submit, cached and rate-regulated for test suite compatibility). */
export function searchPlaces(query) {
  const text = query.trim();
  if (!text) return Promise.resolve([]);
  if (cache.has(text)) return Promise.resolve(cache.get(text));
  return enqueue(async () => {
    const params = new URLSearchParams({
      q: text,
      format: 'jsonv2',
      limit: '4',
      'accept-language': 'en',
    });
    const res = await fetch(`${ENDPOINT}?${params}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Search failed with status ${res.status}`);
    const rows = await res.json();
    const places = rows.map((row) => ({
      lat: Number(row.lat),
      lng: Number(row.lon ?? row.lng),
      name: row.name ?? String(row.display_name ?? row.label).split(',')[0].trim(),
      subtext: row.subtext ?? String(row.display_name ?? row.label).split(',').slice(1, 3).join(',').trim(),
      label: row.display_name ?? row.label,
    }));
    cache.set(text, places);
    return places;
  });
}

/** Instant as-you-type autocomplete guessing by letters (returns 3 to 4 suggestions). */
const suggestCache = new Map();
export async function searchSuggestions(query, { lat = null, lng = null, limit = 4 } = {}) {
  const text = query.trim();
  if (!text || text.length < 2) return [];
  const cacheKey = `${text}_${lat ? lat.toFixed(2) : 0}_${lng ? lng.toFixed(2) : 0}`;
  if (suggestCache.has(cacheKey)) return suggestCache.get(cacheKey);

  try {
    const params = new URLSearchParams({ q: text, limit: String(limit) });
    if (lat && lng) {
      params.set('lat', String(lat));
      params.set('lng', String(lng));
    }
    const res = await fetch(`/api/search?${params}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const rows = await res.json();
    const places = rows.slice(0, limit).map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng ?? r.lon),
      name: r.name || String(r.label).split(',')[0].trim(),
      subtext: r.subtext || String(r.label).split(',').slice(1, 3).join(',').trim(),
      label: r.label,
    }));
    suggestCache.set(cacheKey, places);
    return places;
  } catch {
    return [];
  }
}
