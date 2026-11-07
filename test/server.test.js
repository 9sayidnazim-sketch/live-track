// API and server tests. They run against a real HTTP server on a random port,
// with a temporary database that is deleted afterwards.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const publicDir = resolve(projectRoot, 'public');
let dir;
let dbFile;
let app;
let server;
let base;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'livetrack-test-'));
  dbFile = join(dir, 'test.db');
  app = createApp({ dbPath: dbFile, publicDir });
  server = createServer(app.handle);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Sends a request and returns { status, headers, json, text }. */
async function call(method, path, { key, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (key) init.headers['x-api-key'] = key;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON (for example the static pages). Callers use text instead.
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function createSession() {
  const res = await call('POST', '/api/sessions');
  assert.equal(res.status, 201);
  return { id: res.json.session_id, key: res.json.api_key, share: res.json.share_token };
}

/**
 * Opens a Server-Sent Events stream. next(name) waits for an event with that name and returns its data.
 * ended() reports whether the server closed the stream.
 */
async function openStream(path, headers) {
  const res = await fetch(base + path, { headers });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function next(name, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const start = buffer.indexOf(`event: ${name}\n`);
      if (start !== -1) {
        const end = buffer.indexOf('\n\n', start);
        if (end !== -1) {
          const block = buffer.slice(start, end);
          buffer = buffer.slice(end + 2);
          const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
          return JSON.parse(dataLine.slice(6));
        }
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Timed out waiting for the "${name}" event`);
      const chunk = await readWithTimeout(reader, left);
      if (chunk.done) throw new Error(`Stream ended before the "${name}" event arrived`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function ended() {
    const chunk = await readWithTimeout(reader, 3000);
    return chunk.done === true;
  }

  return { next, ended, close: () => reader.cancel().catch(() => {}) };
}

function readWithTimeout(reader, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Read timed out')), ms);
  });
  return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
}

// ---- Basics and CORS -----------------------------------------------------------

test('health answers with CORS enabled', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('preflight requests are answered without credentials', async () => {
  const res = await call('OPTIONS', '/api/location');
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-headers'), /x-api-key/i);
});

test('unknown endpoints get 404 and wrong methods get 405, both as JSON', async () => {
  const unknown = await call('GET', '/api/nope');
  assert.equal(unknown.status, 404);
  assert.ok(unknown.json.error);
  const wrong = await call('GET', '/api/location');
  assert.equal(wrong.status, 405);
  assert.ok(wrong.json.error);
});

// ---- Sessions and keys ---------------------------------------------------------

test('creating a session returns an API key and a share token, and only hashes are stored', async () => {
  const s = await createSession();
  assert.match(s.id, /^ses_/);
  assert.match(s.key, /^lt_/);
  assert.match(s.share, /^lts_/);
  const db = new DatabaseSync(dbFile);
  const dump = JSON.stringify(db.prepare('SELECT * FROM sessions').all());
  db.close();
  assert.ok(!dump.includes(s.key), 'the raw API key must not be stored');
  assert.ok(!dump.includes(s.share), 'the raw share token must not be stored');
});

test('session info shows the key hint, never the key', async () => {
  const s = await createSession();
  const info = await call('GET', `/api/session/${s.id}`, { key: s.key });
  assert.equal(info.status, 200);
  assert.equal(info.json.api_key_hint, s.key.slice(-4));
  assert.ok(!info.text.includes(s.key));
});

test('regenerating the key invalidates the old key and keeps the history', async () => {
  const s = await createSession();
  await call('POST', '/api/location', { key: s.key, body: { lat: 1, lng: 1 } });
  const regen = await call('POST', `/api/session/${s.id}/key`, { key: s.key });
  assert.equal(regen.status, 200);
  assert.notEqual(regen.json.api_key, s.key);
  assert.equal((await call('GET', `/api/location/latest?session_id=${s.id}`, { key: s.key })).status, 401);
  const latest = await call('GET', `/api/location/latest?session_id=${s.id}`, { key: regen.json.api_key });
  assert.equal(latest.status, 200);
  assert.equal(latest.json.lat, 1);
});

test('resetting the share link stops the old link and keeps the new one working', async () => {
  const s = await createSession();
  await call('POST', '/api/location', { key: s.key, body: { lat: 1, lng: 1 } });
  const reset = await call('POST', `/api/session/${s.id}/share-link`, { key: s.key });
  assert.equal(reset.status, 200);
  const oldLink = await call('GET', `/api/location/latest?session_id=${s.id}&share=${s.share}`);
  assert.equal(oldLink.status, 401);
  const newLink = await call('GET', `/api/location/latest?session_id=${s.id}&share=${reset.json.share_token}`);
  assert.equal(newLink.status, 200);
});

test('revoking disables the key, the share link and new positions', async () => {
  const s = await createSession();
  const revoked = await call('DELETE', `/api/session/${s.id}/key`, { key: s.key });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.revoked_at);
  assert.equal((await call('GET', `/api/session/${s.id}`, { key: s.key })).status, 401);
  assert.equal((await call('GET', `/api/location/latest?session_id=${s.id}&share=${s.share}`)).status, 401);
  assert.equal((await call('POST', '/api/location', { key: s.key, body: { lat: 1, lng: 1 } })).status, 401);
});

test('a key cannot act on a different session', async () => {
  const a = await createSession();
  const b = await createSession();
  const res = await call('GET', `/api/location/latest?session_id=${b.id}`, { key: a.key });
  assert.equal(res.status, 403);
});

test('requests without credentials get 401', async () => {
  const res = await call('GET', '/api/location/history');
  assert.equal(res.status, 401);
  assert.match(res.json.error, /x-api-key/);
});

// ---- Positions -----------------------------------------------------------------

test('posting a position needs the key and saves the point', async () => {
  const s = await createSession();
  const res = await call('POST', '/api/location', {
    key: s.key,
    body: { lat: 51.5007, lng: -0.1246, accuracy: 8, speed: 3.2, timestamp: '2026-11-06T10:00:00Z' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.session_id, s.id);
  assert.equal(res.json.timestamp, '2026-11-06T10:00:00.000Z');
  assert.equal(res.json.accuracy, 8);
  assert.equal(res.json.speed, 3.2);
});

test('optional fields default to null and the time defaults to now', async () => {
  const s = await createSession();
  const before = Date.now();
  const res = await call('POST', '/api/location', { key: s.key, body: { lat: 1, lng: 2 } });
  assert.equal(res.status, 201);
  assert.equal(res.json.accuracy, null);
  assert.equal(res.json.speed, null);
  assert.ok(Date.parse(res.json.timestamp) >= before - 1000);
});

test('invalid positions are rejected with 400', async () => {
  const s = await createSession();
  const cases = [
    { lat: 91, lng: 0 },
    { lat: 0, lng: 181 },
    { lat: 'north', lng: 0 },
    { lng: 0 },
    { lat: 1, lng: 1, accuracy: -5 },
    { lat: 1, lng: 1, speed: -1 },
    { lat: 1, lng: 1, timestamp: 'not a date' },
    [1, 2],
  ];
  for (const body of cases) {
    const res = await call('POST', '/api/location', { key: s.key, body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const malformed = await call('POST', '/api/location', { key: s.key, body: '{"lat":' });
  assert.equal(malformed.status, 400);
});

test('a body over 16 KB is refused with 413', async () => {
  const s = await createSession();
  const body = JSON.stringify({ lat: 1, lng: 1, padding: 'x'.repeat(20_000) });
  const res = await call('POST', '/api/location', { key: s.key, body });
  assert.equal(res.status, 413);
});

test('latest returns the newest point, and history returns the newest N oldest first', async () => {
  const s = await createSession();
  const none = await call('GET', `/api/location/latest?session_id=${s.id}`, { key: s.key });
  assert.equal(none.status, 404);
  for (let i = 1; i <= 5; i += 1) {
    await call('POST', '/api/location', {
      key: s.key,
      body: { lat: 10 + i, lng: 20, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() },
    });
  }
  const latest = await call('GET', `/api/location/latest?session_id=${s.id}`, { key: s.key });
  assert.equal(latest.json.lat, 15);
  const trail = await call('GET', `/api/location/history?session_id=${s.id}&limit=3`, { key: s.key });
  assert.equal(trail.json.count, 3);
  assert.deepEqual(
    trail.json.points.map((p) => p.lat),
    [13, 14, 15],
  );
  const everything = await call('GET', `/api/location/history?session_id=${s.id}`, { key: s.key });
  assert.equal(everything.json.count, 5);
});

test('session_id can be omitted when the key already identifies the session', async () => {
  const s = await createSession();
  await call('POST', '/api/location', { key: s.key, body: { lat: 3, lng: 4 } });
  const res = await call('GET', '/api/location/latest', { key: s.key });
  assert.equal(res.status, 200);
  assert.equal(res.json.session_id, s.id);
});

test('history limit must be a whole number from 1 to 1000', async () => {
  const s = await createSession();
  for (const limit of ['0', '1001', 'abc', '2.5']) {
    const res = await call('GET', `/api/location/history?limit=${limit}`, { key: s.key });
    assert.equal(res.status, 400, `limit=${limit}`);
  }
});

// ---- Share links -----------------------------------------------------------------

test('a share token can read but cannot write', async () => {
  const s = await createSession();
  await call('POST', '/api/location', { key: s.key, body: { lat: 1, lng: 1 } });
  const read = await call('GET', `/api/location/latest?session_id=${s.id}&share=${s.share}`);
  assert.equal(read.status, 200);
  const write = await call('POST', `/api/location?share=${s.share}`, { body: { lat: 2, lng: 2 } });
  assert.equal(write.status, 403);
  const wrong = await call('GET', `/api/location/latest?session_id=${s.id}&share=lts_wrong`);
  assert.equal(wrong.status, 401);
});

// ---- Live stream -------------------------------------------------------------------

test('the stream sends the latest point, then new positions, then a revoked event', async () => {
  const s = await createSession();
  await call('POST', '/api/location', { key: s.key, body: { lat: 5, lng: 6 } });
  const stream = await openStream(`/api/session/${s.id}/stream`, { 'x-api-key': s.key });
  const ready = await stream.next('ready');
  assert.equal(ready.latest.lat, 5);
  await call('POST', '/api/location', { key: s.key, body: { lat: 7, lng: 8 } });
  const update = await stream.next('location');
  assert.equal(update.lat, 7);
  await call('DELETE', `/api/session/${s.id}/key`, { key: s.key });
  const revoked = await stream.next('revoked');
  assert.equal(revoked.session_id, s.id);
  assert.equal(await stream.ended(), true);
  stream.close();
});

test('a share viewer receives updates and is disconnected when the link is reset', async () => {
  const s = await createSession();
  const viewer = await openStream(`/api/session/${s.id}/stream?share=${s.share}`, {});
  const ready = await viewer.next('ready');
  assert.equal(ready.latest, null);
  await call('POST', '/api/location', { key: s.key, body: { lat: 9, lng: 9 } });
  assert.equal((await viewer.next('location')).lat, 9);
  await call('POST', `/api/session/${s.id}/share-link`, { key: s.key });
  const notice = await viewer.next('revoked');
  assert.match(notice.reason, /share link reset/);
  assert.equal(await viewer.ended(), true);
  viewer.close();
});

test('a stream cannot be opened with a key that belongs to another session', async () => {
  const a = await createSession();
  const b = await createSession();
  const res = await fetch(`${base}/api/session/${b.id}/stream`, { headers: { 'x-api-key': a.key } });
  assert.equal(res.status, 403);
  await res.body?.cancel();
});

// ---- Static pages and path safety ---------------------------------------------------

test('the home page is served with a content security policy', async () => {
  const res = await call('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
});

test('clean URLs map to pages, for example /settings to settings.html', async () => {
  const res = await call('GET', '/settings');
  assert.equal(res.status, 200);
  assert.match(res.text, /<title>Settings/);
});

test('files outside the public folder cannot be read', async () => {
  const status = await new Promise((done, fail) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.address().port, path: '/..%2F..%2Fpackage.json' },
      (res) => {
        res.resume();
        done(res.statusCode);
      },
    );
    req.on('error', fail);
    req.end();
  });
  assert.equal(status, 404);
});
