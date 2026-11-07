// The HTTP application: the JSON API, live streams and the static web pages.
import { openDatabase } from './db.js';
import { createHub } from './sse.js';
import { hashSecret, newApiKey, newSessionId, newShareToken } from './tokens.js';
import { HttpError, readJson, sendError, sendJson, serveStatic, setCors } from './http.js';

const ID = '([A-Za-z0-9_-]{1,64})'; // a session id as it appears in a URL path

// Supabase cloud synchronization configuration
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://fdupudjnsxrwldzsukfn.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkdXB1ZGpuc3hyd2xkenN1a2ZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0ODU3ODgsImV4cCI6MjEwODA2MTc4OH0.GFYWg-Dm2eHERz9OI-XA3LezWNAWbAAtmEMOgSJ9_C8';

async function syncToSupabase({ sessionId, point, body = {} }) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    // 1. Sync to columbus_locations
    await fetch(`${SUPABASE_URL}/rest/v1/columbus_locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        session_id: sessionId,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy ?? null,
        speed: point.speed ?? null,
        heading: typeof body?.heading === 'number' ? body.heading : null,
        altitude: typeof body?.altitude === 'number' ? body.altitude : null,
        battery: typeof body?.battery === 'number' ? body.battery : null,
        device_info: body?.device_info ?? null,
        created_at: point.timestamp,
      }),
    });

    // 2. Upsert columbus_sessions status
    await fetch(`${SUPABASE_URL}/rest/v1/columbus_sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        session_id: sessionId,
        name: 'Columbus Tracker',
        status: 'active',
        updated_at: new Date().toISOString(),
      }),
    });

    // 3. Keep legacy fleet table encore_live_location updated if available
    await fetch(`${SUPABASE_URL}/rest/v1/encore_live_location`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        leg_id: 1,
        driver_id: 1,
        lat: point.lat,
        lng: point.lng,
        heading: typeof body?.heading === 'number' ? body.heading : 0,
        speed: typeof body?.speed === 'number' ? body.speed : 0,
        accuracy: typeof point.accuracy === 'number' ? point.accuracy : 0,
        updated_at: point.timestamp,
      }),
    }).catch(() => {});
  } catch (err) {
    console.error('Supabase sync warning:', err.message);
  }
}

/**
 * Builds the request handler.
 * @param {{ dbPath: string, publicDir: string }} options
 * @returns {{ handle: (req, res) => Promise<void>, close: () => void }}
 */
export function createApp({ dbPath, publicDir }) {
  const db = openDatabase(dbPath);
  const hub = createHub();
  const heartbeat = hub.startHeartbeat();

  function authenticate(req, url) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== undefined) {
      const session = db.findByKeyHash(hashSecret(String(apiKey)));
      if (!session) throw new HttpError(401, 'Invalid or revoked API key');
      return { session, access: 'key' };
    }
    const share = url.searchParams.get('share');
    if (share) {
      const session = db.findByShareHash(hashSecret(share));
      if (!session) throw new HttpError(401, 'Invalid or revoked share link');
      return { session, access: 'share' };
    }
    throw new HttpError(401, 'Send your API key in the x-api-key header');
  }

  function authorize(req, url, { sessionId = null, keyOnly = false } = {}) {
    const auth = authenticate(req, url);
    if (sessionId && auth.session.id !== sessionId) {
      throw new HttpError(403, 'These credentials do not belong to that session');
    }
    if (keyOnly && auth.access !== 'key') {
      throw new HttpError(403, 'Share links are read-only. Use your API key.');
    }
    return auth;
  }

  // ---- Session management -------------------------------------------------

  function createSession({ res }) {
    const id = newSessionId();
    const apiKey = newApiKey();
    const shareToken = newShareToken();
    const createdAt = new Date().toISOString();
    db.createSession({
      id,
      apiKeyHash: hashSecret(apiKey),
      apiKeyHint: apiKey.slice(-4),
      shareHash: hashSecret(shareToken),
      createdAt,
    });
    sendJson(res, 201, { session_id: id, api_key: apiKey, share_token: shareToken, created_at: createdAt });
  }

  function getSession({ req, res, url, params }) {
    const { session } = authorize(req, url, { sessionId: params[0], keyOnly: true });
    sendJson(res, 200, {
      session_id: session.id,
      active: true,
      created_at: session.created_at,
      api_key_hint: session.api_key_hint,
    });
  }

  function regenerateKey({ req, res, url, params }) {
    const { session } = authorize(req, url, { sessionId: params[0], keyOnly: true });
    const apiKey = newApiKey();
    db.replaceKey(session.id, hashSecret(apiKey), apiKey.slice(-4));
    hub.close(session.id, {
      event: 'revoked',
      data: { session_id: session.id, reason: 'API key replaced' },
      access: 'key',
    });
    sendJson(res, 200, { session_id: session.id, api_key: apiKey });
  }

  function revokeKey({ req, res, url, params }) {
    const { session } = authorize(req, url, { sessionId: params[0], keyOnly: true });
    const revokedAt = new Date().toISOString();
    db.revoke(session.id, revokedAt);
    hub.close(session.id, { event: 'revoked', data: { session_id: session.id, reason: 'API key revoked' } });
    sendJson(res, 200, { session_id: session.id, revoked_at: revokedAt });
  }

  function resetShareLink({ req, res, url, params }) {
    const { session } = authorize(req, url, { sessionId: params[0], keyOnly: true });
    const shareToken = newShareToken();
    db.replaceShare(session.id, hashSecret(shareToken));
    hub.close(session.id, {
      event: 'revoked',
      data: { session_id: session.id, reason: 'share link reset' },
      access: 'share',
    });
    sendJson(res, 200, { session_id: session.id, share_token: shareToken });
  }

  // ---- Locations ----------------------------------------------------------

  async function postLocation({ req, res, url }) {
    const { session } = authorize(req, url, { keyOnly: true });
    const body = await readJson(req);
    if (!isPlainObject(body)) throw new HttpError(400, 'Send a JSON object with lat and lng');
    if (body.session_id !== undefined && body.session_id !== session.id) {
      throw new HttpError(403, 'session_id does not match your API key');
    }
    const point = parsePoint(body);
    const row = db.insertLocation(session.id, point);
    hub.publish(session.id, 'location', row);

    // Sync to Supabase cloud in the background
    syncToSupabase({ sessionId: session.id, point: row, body }).catch(() => {});

    sendJson(res, 201, row);
  }

  function latestLocation({ req, res, url }) {
    const { session } = authorize(req, url, { sessionId: url.searchParams.get('session_id') });
    const row = db.latestLocation(session.id);
    if (!row) throw new HttpError(404, 'No positions recorded for this session yet');
    sendJson(res, 200, row);
  }

  function historyLocations({ req, res, url }) {
    const { session } = authorize(req, url, { sessionId: url.searchParams.get('session_id') });
    const points = db.history(session.id, parseLimit(url.searchParams.get('limit')));
    sendJson(res, 200, { session_id: session.id, count: points.length, points });
  }

  function streamSession({ req, res, url, params }) {
    const { access } = authorize(req, url, { sessionId: params[0] });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const latest = db.latestLocation(params[0]);
    res.write(`event: ready\ndata: ${JSON.stringify({ session_id: params[0], latest })}\n\n`);
    hub.subscribe(params[0], res, access);
    res.on('close', () => hub.unsubscribe(params[0], res));
  }

  // ---- Map & Service Proxies (Backend handles Map APIs) -------------------

  async function searchProxy({ res, url }) {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return sendJson(res, 200, []);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 4, 1), 4);
    const lat = url.searchParams.get('lat');
    const lng = url.searchParams.get('lng');
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;

    // 1. Google Places Autocomplete API (when Google API key is provided)
    if (googleApiKey) {
      try {
        let gUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(q)}&language=en&key=${googleApiKey}`;
        if (lat && lng && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
          gUrl += `&location=${lat},${lng}&radius=50000`;
        }
        const gRes = await fetch(gUrl, { signal: AbortSignal.timeout(4000) });
        const gData = await gRes.json();
        if (gData.status === 'OK' && Array.isArray(gData.predictions) && gData.predictions.length > 0) {
          const preds = gData.predictions.slice(0, limit);
          const results = await Promise.all(
            preds.map(async (pred) => {
              try {
                const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${pred.place_id}&language=en&fields=geometry,name,formatted_address&key=${googleApiKey}`;
                const dRes = await fetch(detailUrl, { signal: AbortSignal.timeout(3000) });
                const dData = await dRes.json();
                const loc = dData.result?.geometry?.location;
                if (loc) {
                  const name = pred.structured_formatting?.main_text || dData.result?.name || pred.description;
                  const subtext = pred.structured_formatting?.secondary_text || '';
                  return {
                    lat: loc.lat,
                    lng: loc.lng,
                    name,
                    subtext,
                    label: subtext ? `${name}, ${subtext}` : name,
                  };
                }
              } catch {}
              return null;
            })
          );
          const valid = results.filter(Boolean);
          if (valid.length > 0) return sendJson(res, 200, valid);
        }
      } catch (err) {
        console.warn('Google Places Autocomplete fallback:', err.message);
      }
    }

    // 2. High-speed Typeahead Engine (Photon) with letter-guessing & location biasing (English results)
    try {
      let photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=${limit}&lang=en`;
      if (lat && lng && !isNaN(Number(lat)) && !isNaN(Number(lng))) {
        photonUrl += `&lat=${lat}&lon=${lng}`;
      }
      const response = await fetch(photonUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'Columbus-LiveTrack/1.0' },
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.features) && data.features.length > 0) {
          const places = data.features.slice(0, limit).map((f) => {
            const p = f.properties || {};
            const coords = f.geometry?.coordinates || [0, 0];
            const name = p.name || p.street || p.city || 'Place';
            const context = [p.street, p.district || p.locality, p.city, p.state, p.country].filter(
              (part) => part && part !== name
            );
            const subtext = context.slice(0, 2).join(', ');
            return {
              lat: coords[1],
              lng: coords[0],
              name: name,
              subtext: subtext,
              label: subtext ? `${name}, ${subtext}` : name,
            };
          });
          return sendJson(res, 200, places);
        }
      }
    } catch (err) {
      console.warn('Photon typeahead fallback:', err.message);
    }

    // 3. Fallback to OpenStreetMap Nominatim (English results)
    try {
      const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=${limit}&accept-language=en`;
      const response = await fetch(nominatimUrl, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en',
          'User-Agent': 'Columbus-LiveTrack/1.0 (contact: apps.octapus@gmail.com)',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const rows = await response.json();
        const places = rows.slice(0, limit).map((row) => {
          const parts = row.display_name.split(',');
          const name = parts[0].trim();
          const subtext = parts.slice(1, 3).join(',').trim();
          return {
            lat: Number(row.lat),
            lng: Number(row.lon),
            name: name,
            subtext: subtext,
            label: row.display_name,
          };
        });
        return sendJson(res, 200, places);
      }
    } catch (err) {
      return sendJson(res, 502, { error: 'Search error: ' + err.message });
    }

    sendJson(res, 200, []);
  }

  async function routeProxy({ res, url, params }) {
    let fromLat, fromLng, toLat, toLng;
    if (params && params[0]) {
      // Form: lng1,lat1;lng2,lat2
      const [p1, p2] = params[0].split(';');
      if (p1 && p2) {
        [fromLng, fromLat] = p1.split(',').map(Number);
        [toLng, toLat] = p2.split(',').map(Number);
      }
    }
    if (isNaN(fromLat) || isNaN(toLat)) {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from && to) {
        [fromLat, fromLng] = from.split(',').map(Number);
        [toLat, toLng] = to.split(',').map(Number);
      }
    }
    if (isNaN(fromLat) || isNaN(toLat)) {
      return sendError(res, 400, 'from and to coordinates required');
    }

    try {
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(osrmUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'Columbus-LiveTrack/1.0' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) throw new Error('OSRM status ' + response.status);
      const data = await response.json();
      const route = data.routes?.[0];
      if (data.code !== 'Ok' || !route) throw new Error('No route found');

      sendJson(res, 200, {
        code: 'Ok',
        routes: [route],
        coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distance: route.distance,
        duration: route.duration,
        fallback: false,
      });
    } catch {
      // Straight-line fallback
      const R = 6371000;
      const dLat = ((toLat - fromLat) * Math.PI) / 180;
      const dLng = ((toLng - fromLng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((fromLat * Math.PI) / 180) * Math.cos((toLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
      const distance = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const duration = distance / (40 / 3.6);
      sendJson(res, 200, {
        code: 'Fallback',
        routes: [],
        coords: [
          [fromLat, fromLng],
          [toLat, toLng],
        ],
        distance,
        duration,
        fallback: true,
      });
    }
  }

  function supabaseStatus({ res }) {
    sendJson(res, 200, {
      connected: true,
      project_id: 'fdupudjnsxrwldzsukfn',
      url: SUPABASE_URL,
      tables: ['columbus_locations', 'columbus_sessions', 'encore_live_location'],
    });
  }

  // ---- Routing ------------------------------------------------------------

  const routes = [
    ['GET', /^\/api\/health$/, ({ res }) => sendJson(res, 200, { ok: true, time: new Date().toISOString() })],
    ['GET', /^\/api\/supabase\/status$/, supabaseStatus],
    ['GET', /^\/api\/search$/, searchProxy],
    ['GET', /^\/api\/route$/, routeProxy],
    ['GET', /^\/route\/v1\/driving\/(.+)$/, routeProxy],
    ['GET', /^\/api\/route\/v1\/driving\/(.+)$/, routeProxy],
    ['POST', /^\/api\/sessions$/, createSession],
    ['POST', /^\/api\/location$/, postLocation],
    ['GET', /^\/api\/location\/latest$/, latestLocation],
    ['GET', /^\/api\/location\/history$/, historyLocations],
    ['GET', new RegExp(`^/api/session/${ID}$`), getSession],
    ['GET', new RegExp(`^/api/session/${ID}/stream$`), streamSession],
    ['POST', new RegExp(`^/api/session/${ID}/key$`), regenerateKey],
    ['DELETE', new RegExp(`^/api/session/${ID}/key$`), revokeKey],
    ['POST', new RegExp(`^/api/session/${ID}/share-link$`), resetShareLink],
  ];

  async function routeApi(req, res, url) {
    let pathFound = false;
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      pathFound = true;
      if (method === req.method) {
        return handler({ req, res, url, params: match.slice(1) });
      }
    }
    if (pathFound) throw new HttpError(405, `${req.method} is not allowed on this endpoint`);
    throw new HttpError(404, 'Unknown endpoint');
  }

  async function serveWeb(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (!(await serveStatic(req, res, url.pathname, publicDir))) throw new HttpError(404, 'Not found');
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/route/')) return await serveWeb(req, res, url);
      setCors(res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      return await routeApi(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      console.error('Unexpected error:', err.message);
      return sendError(res, 500, 'Internal server error');
    }
  }

  return {
    handle,
    close() {
      clearInterval(heartbeat);
      db.close();
    },
  };
}

// ---- Validation helpers -----------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value, name) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
}

function optionalNumber(value, name) {
  return value === undefined || value === null ? null : toNumber(value, name);
}

function parseTimestamp(value) {
  if (value === undefined || value === null) return new Date().toISOString();
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, 'timestamp must be ISO 8601 text or epoch milliseconds');
  }
  return date.toISOString();
}

function parsePoint(body) {
  const lat = toNumber(body.lat, 'lat');
  const lng = toNumber(body.lng, 'lng');
  if (lat < -90 || lat > 90) throw new HttpError(400, 'lat must be between -90 and 90');
  if (lng < -180 || lng > 180) throw new HttpError(400, 'lng must be between -180 and 180');
  const accuracy = optionalNumber(body.accuracy, 'accuracy');
  const speed = optionalNumber(body.speed, 'speed');
  if (accuracy !== null && accuracy < 0) throw new HttpError(400, 'accuracy cannot be negative');
  if (speed !== null && speed < 0) throw new HttpError(400, 'speed cannot be negative');
  return { lat, lng, accuracy, speed, timestamp: parseTimestamp(body.timestamp) };
}

function parseLimit(raw) {
  if (raw === null || raw === '') return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new HttpError(400, 'limit must be a whole number from 1 to 1000');
  }
  return n;
}
