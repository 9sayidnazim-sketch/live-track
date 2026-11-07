// SQLite storage through Node's built-in node:sqlite, so there is no native build step.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,      -- public session id, e.g. ses_xxxxxxxxxxxx
    api_key_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of the API key. The key itself is never stored.
    api_key_hint TEXT NOT NULL,         -- last four characters of the key, for display only
    share_hash   TEXT NOT NULL UNIQUE,  -- SHA-256 of the read-only share token
    created_at   TEXT NOT NULL,         -- ISO 8601, UTC
    revoked_at   TEXT                   -- NULL while the key is active
  );

  CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    lat        REAL NOT NULL,
    lng        REAL NOT NULL,
    accuracy   REAL,                    -- metres, may be NULL
    speed      REAL,                    -- metres per second, may be NULL
    timestamp  TEXT NOT NULL            -- ISO 8601, UTC, time of the GPS fix
  );

  CREATE INDEX IF NOT EXISTS idx_locations_session ON locations (session_id, id);
`;

const COLUMNS = 'id, session_id, lat, lng, accuracy, speed, timestamp';

/** Opens the database (creating the file and tables if needed) and returns data-access functions. */
export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const sql = {
    insertSession: db.prepare(
      'INSERT INTO sessions (id, api_key_hash, api_key_hint, share_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    activeByKeyHash: db.prepare('SELECT * FROM sessions WHERE api_key_hash = ? AND revoked_at IS NULL'),
    activeByShareHash: db.prepare('SELECT * FROM sessions WHERE share_hash = ? AND revoked_at IS NULL'),
    replaceKey: db.prepare('UPDATE sessions SET api_key_hash = ?, api_key_hint = ? WHERE id = ?'),
    replaceShare: db.prepare('UPDATE sessions SET share_hash = ? WHERE id = ?'),
    revoke: db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    insertLocation: db.prepare(
      'INSERT INTO locations (session_id, lat, lng, accuracy, speed, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    locationById: db.prepare(`SELECT ${COLUMNS} FROM locations WHERE id = ?`),
    latest: db.prepare(`SELECT ${COLUMNS} FROM locations WHERE session_id = ? ORDER BY id DESC LIMIT 1`),
    // The newest N points, returned oldest first so the array reads as a trail.
    history: db.prepare(
      `SELECT * FROM (SELECT ${COLUMNS} FROM locations WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
    ),
  };

  return {
    close: () => db.close(),
    createSession: (row) =>
      sql.insertSession.run(row.id, row.apiKeyHash, row.apiKeyHint, row.shareHash, row.createdAt),
    getSession: (id) => sql.sessionById.get(id) ?? null,
    // Lookups ignore revoked sessions, so a revoked key or share link stops working at once.
    findByKeyHash: (hash) => sql.activeByKeyHash.get(hash) ?? null,
    findByShareHash: (hash) => sql.activeByShareHash.get(hash) ?? null,
    replaceKey: (id, apiKeyHash, apiKeyHint) => sql.replaceKey.run(apiKeyHash, apiKeyHint, id),
    replaceShare: (id, shareHash) => sql.replaceShare.run(shareHash, id),
    revoke: (id, revokedAt) => sql.revoke.run(revokedAt, id),
    insertLocation(sessionId, point) {
      const info = sql.insertLocation.run(
        sessionId,
        point.lat,
        point.lng,
        point.accuracy,
        point.speed,
        point.timestamp,
      );
      return sql.locationById.get(Number(info.lastInsertRowid));
    },
    latestLocation: (sessionId) => sql.latest.get(sessionId) ?? null,
    history: (sessionId, limit) => sql.history.all(sessionId, limit),
  };
}
