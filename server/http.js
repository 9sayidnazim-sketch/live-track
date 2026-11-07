// Small HTTP helpers: JSON replies, CORS, body parsing and static files.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const MAX_BODY_BYTES = 16 * 1024;

/** An error with an HTTP status. The message is sent to the caller as JSON. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** Lets browsers and other apps call the API from any origin. Auth uses a header, not cookies. */
export function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Max-Age', '600');
}

/** Reads and parses a JSON body. Resolves undefined for an empty body. Any Content-Type is accepted. */
export function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new HttpError(413, `Request body is larger than ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(text));
      } catch {
        rejectBody(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', rejectBody);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/**
 * Content-Security-Policy for the pages. Scripts come only from this origin.
 * Connections go to the same origin plus the services the app calls directly:
 * Nominatim (search) and OSRM (routing). Tiles come from OpenStreetMap.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.tile.openstreetmap.org",
  "font-src 'self'",
  "connect-src 'self' https://photon.komoot.io https://nominatim.openstreetmap.org https://router.project-osrm.org https://*.supabase.co wss://*.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/**
 * Serves a file from publicDir. Returns false when nothing matches, so the caller sends a 404.
 * "/settings" is served as settings.html. Resolved paths must stay inside publicDir.
 */
export async function serveStatic(req, res, pathname, publicDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relative = decoded === '/' ? '/index.html' : decoded;
  let file = resolve(publicDir, `.${relative}`);
  if (!file.startsWith(publicDir + sep)) return false;
  if (!extname(file)) file += '.html';

  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-cache' };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = PAGE_CSP;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
