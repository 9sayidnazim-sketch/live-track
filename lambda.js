import { createApp } from './server/app.js';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

let app = null;
function getApp() {
  if (!app) {
    app = createApp({
      dbPath: '/tmp/livetrack.db',
      publicDir: resolve(process.cwd(), 'public'),
    });
  }
  return app;
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  let path = event.rawPath || event.path || '/';
  if (path === '') path = '/';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${path}${qs}`;
  const headers = event.headers || {};

  return new Promise((resolvePromise) => {
    const req = new Readable({
      read() {
        if (event.body) {
          const buffer = event.isBase64Encoded
            ? Buffer.from(event.body, 'base64')
            : Buffer.from(event.body, 'utf-8');
          this.push(buffer);
        }
        this.push(null);
      },
    });
    req.method = method;
    req.url = url;
    req.headers = headers;

    const resHeaders = {};
    const chunks = [];
    let statusCode = 200;

    const res = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
        callback();
      },
    });

    res.statusCode = 200;
    res.setHeader = (name, value) => {
      resHeaders[name.toLowerCase()] = String(value);
    };
    res.getHeader = (name) => resHeaders[name.toLowerCase()];
    res.writeHead = (code, h) => {
      statusCode = code;
      if (h) {
        for (const [k, v] of Object.entries(h)) {
          resHeaders[k.toLowerCase()] = String(v);
        }
      }
    };

    res.on('finish', () => {
      const bodyBuffer = Buffer.concat(chunks);
      const contentType = resHeaders['content-type'] || '';
      const isBinary = /image|font|octet-stream|pdf|woff|zip/i.test(contentType);

      resolvePromise({
        statusCode: res.statusCode || statusCode,
        headers: resHeaders,
        body: isBinary ? bodyBuffer.toString('base64') : bodyBuffer.toString('utf-8'),
        isBase64Encoded: isBinary,
      });
    });

    getApp()
      .handle(req, res)
      .catch((err) => {
        resolvePromise({
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ error: err.message }),
        });
      });
  });
}
