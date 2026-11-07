// Place search (Nominatim), road routing (OSRM) and the API client, with the network mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPlaces } from '../public/js/nominatim.js';
import { fetchRoute, straightRoute } from '../public/js/osrm.js';
import { api, ApiError } from '../public/js/api-client.js';

const realFetch = globalThis.fetch;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const A = { lat: 51.5, lng: -0.1 };
const B = { lat: 51.6, lng: -0.2 };

test('searches go out one at a time, at least 1.1 seconds apart', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push({ url: String(url), at: Date.now() });
    return json([{ lat: '51.5', lon: '-0.12', display_name: 'London, England' }]);
  };
  try {
    const results = await Promise.all(['alpha', 'beta', 'gamma'].map((q) => searchPlaces(q)));
    assert.equal(results[0][0].label, 'London, England');
    assert.equal(results[0][0].lat, 51.5);
    assert.equal(results[0][0].lng, -0.12);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].url.includes('format=jsonv2'));
    assert.ok(calls[0].url.includes('q=alpha'));
    for (let i = 1; i < calls.length; i += 1) {
      const gap = calls[i].at - calls[i - 1].at;
      assert.ok(gap >= 1090, `gap was ${gap} ms`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a repeated search is answered from the cache', async () => {
  let count = 0;
  globalThis.fetch = async () => {
    count += 1;
    return json([]);
  };
  try {
    await searchPlaces('cached place');
    await searchPlaces('cached place');
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed search rejects, so the page can show a message', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    await assert.rejects(searchPlaces('broken query'), /503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an OSRM route is converted to [lat, lng] points with its distance and duration', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /route\/v1\/driving\/-0\.1,51\.5;-0\.2,51\.6\?overview=full&geometries=geojson/);
    return json({
      code: 'Ok',
      routes: [
        {
          distance: 1234,
          duration: 321,
          geometry: {
            coordinates: [
              [-0.1, 51.5],
              [-0.15, 51.55],
              [-0.2, 51.6],
            ],
          },
        },
      ],
    });
  };
  try {
    const route = await fetchRoute(A, B);
    assert.equal(route.fallback, false);
    assert.deepEqual(route.coords[1], [51.55, -0.15]);
    assert.equal(route.distance, 1234);
    assert.equal(route.duration, 321);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an HTTP error from the router falls back to a straight line', async () => {
  globalThis.fetch = async () => new Response('busy', { status: 429 });
  try {
    const route = await fetchRoute(A, B);
    assert.equal(route.fallback, true);
    assert.equal(route.coords.length, 2);
    assert.ok(route.distance > 10_000);
    assert.ok(route.duration > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a router reply without a route falls back to a straight line', async () => {
  globalThis.fetch = async () => json({ code: 'NoRoute', routes: [] });
  try {
    assert.equal((await fetchRoute(A, B)).fallback, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a router that never answers is abandoned after the timeout', async () => {
  globalThis.fetch = (url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const started = Date.now();
  try {
    const route = await fetchRoute(A, B, { timeoutMs: 50 });
    assert.equal(route.fallback, true);
    assert.ok(Date.now() - started < 1000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a straight route estimates time at 40 km/h', () => {
  const route = straightRoute({ lat: 0, lng: 0 }, { lat: 0, lng: 0.009 });
  // About 1 km at 40 km/h is about 90 seconds.
  assert.ok(Math.abs(route.duration - route.distance / (40 / 3.6)) < 1e-9);
  assert.ok(route.duration > 85 && route.duration < 95, `got ${route.duration}`);
});

test('api() returns the JSON body and throws ApiError with the server message', async () => {
  globalThis.fetch = async () => json({ error: 'Invalid or revoked API key' }, 401);
  try {
    await assert.rejects(api('/api/location/latest?session_id=x'), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      assert.equal(err.message, 'Invalid or revoked API key');
      return true;
    });
    globalThis.fetch = async () => json({ ok: true });
    assert.deepEqual(await api('/api/health'), { ok: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('api() reports status 0 when the server cannot be reached', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    await assert.rejects(api('/api/health'), (err) => err.status === 0 && /Could not reach/.test(err.message));
  } finally {
    globalThis.fetch = realFetch;
  }
});
