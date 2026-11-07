// Starts the server. Environment variables:
//   PORT                 port to listen on (default 3000)
//   HOST                 interface to bind (default 127.0.0.1)
//   DB_PATH              SQLite file (default data/livetrack.db inside the project)
//   TLS_CERT, TLS_KEY    PEM files. When both are set, the server speaks HTTPS.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
const dbPath = process.env.DB_PATH || join(root, 'data', 'livetrack.db');
const publicDir = resolve(root, 'public');

const app = createApp({ dbPath, publicDir });
const useTls = Boolean(process.env.TLS_CERT && process.env.TLS_KEY);
const server = useTls
  ? createHttps({ cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }, app.handle)
  : createHttp(app.handle);

server.listen(port, host, () => {
  console.log(`Live Track is running at ${useTls ? 'https' : 'http'}://${host}:${port}`);
  if (!useTls) console.log('Phones only allow GPS over HTTPS. See the README for tunnel and TLS options.');
});

// Stop cleanly on Ctrl+C or when a process manager asks.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.closeAllConnections();
    server.close(() => {
      app.close();
      process.exit(0);
    });
  });
}
