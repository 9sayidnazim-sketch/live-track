import { createApp } from '../server/app.js';
import { resolve } from 'node:path';

let app = null;

function getApp() {
  if (!app) {
    app = createApp({
      dbPath: process.env.DB_PATH || '/tmp/livetrack.db',
      publicDir: resolve(process.cwd(), 'public'),
    });
  }
  return app;
}

export default async function handler(req, res) {
  return getApp().handle(req, res);
}

