# Live Track

A mobile-first web app that shows a car moving on a free OpenStreetMap map, driven by the phone's GPS. Other apps read the positions through a small JSON API.

No paid keys, no accounts, no npm packages. The server uses Node's built-in SQLite.

## Run it

```bash
npm start
```

Then open http://127.0.0.1:3000 in a browser. Node.js 22.13 or newer is required.

Run the tests with:

```bash
npm test
```

## Use it on a phone

Phones give GPS only to pages served over HTTPS. Pick one of these:

1. **Quick test through a tunnel.** Run the server, then open a second terminal and start a tunnel, for example `cloudflared tunnel --url http://127.0.0.1:3000`. Open the `https://` address it prints on the phone. The address changes each time the tunnel starts.
2. **Your own certificate.** Set `TLS_CERT` and `TLS_KEY` to PEM files. The phone must trust the certificate.
3. **A hosted server.** Deploy to any host that runs Node, serves HTTPS, and has a persistent disk for the SQLite file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to expose it on your network |
| `DB_PATH` | `data/livetrack.db` | SQLite file |
| `TLS_CERT`, `TLS_KEY` | unset | When both are set, the server speaks HTTPS |

## How it works

- **Allow GPS** asks for a position. That first fix becomes point **A**, the start of the run. The server then creates a session with its own API key, and the tracker saves a point every 10 seconds.
- **Every 10 seconds** the app reads the GPS with `getCurrentPosition` from a `setInterval`. It saves the reading and glides the car to it over the same 10 seconds using `requestAnimationFrame`. The car turns to face its direction of travel.
- **Point B** is chosen by searching a place name or tapping the map. A road route from the car to B is drawn with OSRM. If routing fails, a dashed straight line is drawn instead and its time is an estimate.
- **Arrival** happens when a reading is within 30 m of B, or within the GPS accuracy if that is larger (capped at 50 m). The car stops at B, tracking stops, and the sheet shows Arrived.
- **Stop tracking** stops the GPS reads, the 10-second timer and any uploads.

## Pages

| Address | What it is |
| --- | --- |
| `/` | The tracking map |
| `/settings.html` | Generate, regenerate or revoke the API key, copy cURL examples, and share the live link |
| `/live.html?session=…&share=…` | Read-only live map for someone else |
| `/api.html` | API documentation |

## API summary

Send the key in the `x-api-key` header. The read endpoints also accept `share=TOKEN` in place of a key. Share tokens are read-only. Full details are on `/api.html`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/api/sessions` | none | Create a session. Returns the API key once |
| POST | `/api/location` | key | Save a position |
| GET | `/api/location/latest?session_id=` | key or share | Newest position |
| GET | `/api/location/history?session_id=&limit=` | key or share | Newest N positions, oldest first (1 to 1000, default 100) |
| GET | `/api/session/:id/stream` | key or share | Live updates as Server-Sent Events: `ready`, `location`, `revoked` |
| GET | `/api/session/:id` | key | Session details (the key hint, never the key) |
| POST | `/api/session/:id/key` | key | Replace the key. The old key stops working at once |
| DELETE | `/api/session/:id/key` | key | Revoke the key and the share link, and end all streams |
| POST | `/api/session/:id/share-link` | key | Replace the share token |
| GET | `/api/health` | none | Server status |

Responses are JSON with CORS enabled. Errors look like `{ "error": "message" }`.

Example:

```bash
curl -H "x-api-key: YOUR_API_KEY" "http://127.0.0.1:3000/api/location/latest?session_id=SESSION_ID"
```

## Privacy and security

- Nothing is read or saved until you tap **Allow GPS**. Tracking is shown on screen and can be stopped at any time.
- Only SHA-256 hashes of keys and share tokens are stored on the server. The full key is kept in this browser's local storage so the tracker and the Settings examples can use it.
- A share link carries its own read-only token, so it never reveals the API key. Resetting the link or revoking the key stops it.
- Request bodies are never logged, because they contain coordinates.
- Scripts may load only from the app's own origin. The pages can connect only to the app, Nominatim and OSRM. The Content Security Policy is set by the server.

**Not yet in place:** positions are kept until you delete the database file, and there is no in-app delete. Session creation is open, with no account or rate limit. Add authentication and rate limiting before you expose the server publicly.

## Design decisions

These are the calls I made, since the spec left them open. Each one can be changed.

1. **Stack.** Plain Node HTTP server, `node:sqlite`, and vanilla ES modules. Leaflet 1.9.4 is vendored under `public/vendor/`. Fonts are self-hosted: Barlow and Barlow Condensed for the interface, and IBM Plex Mono only for code samples.
2. **Look.** White road-map surfaces with a charcoal instrument panel for the telemetry. Green marks A and red marks B. The distance and time are the largest figures, so they read like a dashboard. Tiles are slightly desaturated so the route and car stand out.
3. **A and B.** A is the first GPS fix of each tracking run. It stays put while the car moves. The route always starts at the car, and it is trimmed as the car progresses.
4. **Routing.** OSRM driving profile. A route is requested again only when the car is more than 60 m from it, and at most every 20 seconds.
5. **Search.** Runs on submit, not as you type, because Nominatim's policy forbids autocomplete. Requests start at least 1.1 seconds apart and results are cached.
6. **Follow and Free.** Follow is on by default and keeps the car centred in the area above the sheet. Dragging the map switches to Free. Setting point B also switches to Free and fits both points on screen.
7. **Keys and sharing.** A session has one API key, and the server keeps only its hash. Revoking disables the key and the share link, and closes every open stream. Regenerating keeps the same session and its history.
8. **Reloading.** The page does not start tracking on its own. Tap **Resume tracking**, which uses the saved session and point B.
9. **Settings and docs** open in new tabs, so the tracking tab keeps running.
10. **Failed uploads** are kept in memory, up to 200 points, and sent in order. A point the server rejects as invalid is dropped so it cannot block the queue.
11. **Screen wake lock** is requested while tracking, where the browser supports it.

## Testing

`npm test` runs 45 automated tests:

- **API:** authentication, the share-link rules, validation, the history limit, key replacement, share reset, revocation, the live stream, CORS, static pages and path safety.
- **Geometry and formatting:** distances, bearings, the car's turn, arrival, and the instrument readouts.
- **Car motion:** the glide and its restart, checked with a fake clock.
- **Services:** the one-request-per-second search queue, caching, OSRM parsing, the straight-line fallback and timeout, and the API client.

I also ran these checks by hand in the built-in browser. Location was simulated by replacing `navigator.geolocation`, while Nominatim, OSRM and OpenStreetMap were real:

- Denied, unavailable and timeout messages, and the first permission screen.
- Readings every 10 seconds, with stored points also 10 seconds apart.
- Smooth car motion, with the heading matching the path.
- A road route to a searched place.
- Arrival, after which GPS reads stop.
- Stop and resume, Follow and Free, Clear B, and setting B by tapping the map.
- Revoking the key while tracking, and regenerating it without a break.
- The shared viewer, which receives updates and stops when the link is reset.
- Layouts at phone and desktop widths.
- The sample cURL commands, which passed, and an HTTPS start with a self-signed certificate.

**Not verified:** real phone GPS, the phone's own permission prompts, background behaviour when the screen locks, and the straight-line fallback during a live routing failure (the unit test covers it).

## Known limits

- Mobile browsers pause timers when the screen locks, which leaves gaps in the trail. Keep the page open and the screen on.
- The public OSRM demo and OpenStreetMap tile servers are for light use. For production, run your own routing and tile servers.
- The live-stream hub is in memory, so run one server process.
- No rate limiting, and no account system.
