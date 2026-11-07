// The shared live map. It is read only: it shows the car, its trail and its readings as the owner
// sends them. It uses the share token from the link, never an API key.
import { bearingDeg, distanceM, formatAccuracy, formatClock, formatCoord, formatSpeedKmh } from './geo.js';
import { CarMarker, Glider } from './car.js';
import { centreOn, createMap } from './map.js';
import { api, ApiError } from './api-client.js';
import { getMarkerColor, getMarkerType } from './store.js';
import { $ } from './common.js';

const READ_INTERVAL_MS = 10_000;
const TRAIL_LENGTH = 30;
const TRAIL_REDRAW_MS = 100;

const params = new URLSearchParams(location.search);
const sessionId = params.get('session');
const share = params.get('share');
const enc = encodeURIComponent;

/** The bottom sheet hides the lower part of the map on phones. Desktop has no such cover. */
const coverEl = () => (window.matchMedia('(min-width: 900px)').matches ? null : document.querySelector('.sheet'));

const els = {
  status: $('#status'),
  statusText: $('#status-text'),
  linkStatus: $('#link-status'),
  follow: $('#mode-follow'),
  free: $('#mode-free'),
  clock: $('#updated-clock'),
  lat: $('#lat'),
  lng: $('#lng'),
  acc: $('#acc'),
  speed: $('#speed'),
  banner: $('#banner'),
  message: $('#message'),
  messageTitle: $('#message-title'),
  messageText: $('#message-text'),
};

const S = {
  map: null,
  car: null,
  glider: null,
  accuracyHalo: null,
  trailLine: null,
  trail: [],
  last: null, // latest fix shown
  lastId: 0, // highest position id shown, so history and stream never double up
  lastFixTime: null,
  follow: true,
  lastDraw: 0,
  stream: null,
};

const STATUS_TEXT = {
  connecting: ['Connecting', 'idle'],
  waiting: ['Waiting for the first position', 'idle'],
  live: ['Live', 'live'],
  reconnecting: ['Reconnecting', 'warn'],
  ended: ['Sharing has ended', 'done'],
  invalid: ['Link no longer works', 'done'],
};

function setStatus(kind) {
  const [text, tone] = STATUS_TEXT[kind];
  els.status.dataset.tone = tone;
  els.statusText.textContent = text;
  els.linkStatus.textContent = kind === 'live' ? 'Live link' : text;
}

function start() {
  const desktop = window.matchMedia('(min-width: 900px)').matches;
  S.map = createMap('map', { zoomControl: desktop, attributionPosition: desktop ? 'bottomright' : 'topleft' });
  S.trailLine = L.polyline([], {
    interactive: false,
    color: '#a855f7',
    weight: 4,
    opacity: 0.32,
    lineCap: 'round',
    lineJoin: 'round',
  }).addTo(S.map);
  S.glider = new Glider({ onFrame: onFrame });
  S.map.on('dragstart', () => setFollow(false));
  els.follow.addEventListener('click', () => setFollow(true));
  els.free.addEventListener('click', () => setFollow(false));
  setStatus('connecting');
  loadRecent();
  connect();
}

/** Loads the recent trail, so a viewer who joins late sees where the car has been. */
async function loadRecent() {
  try {
    const data = await api(
      `/api/location/history?session_id=${enc(sessionId)}&limit=${TRAIL_LENGTH}&share=${enc(share)}`,
    );
    for (const point of data.points) addPoint(point, { instant: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) invalidLink();
    // Other errors are not fatal: live updates still arrive through the stream.
  }
}

/** Opens the live stream. Browsers cannot send headers with EventSource, so the share token goes in the URL. */
function connect() {
  const stream = new EventSource(`/api/session/${enc(sessionId)}/stream?share=${enc(share)}`);
  S.stream = stream;
  stream.addEventListener('ready', (event) => {
    const { latest } = JSON.parse(event.data);
    if (latest) addPoint(latest);
    setStatus(S.last ? 'live' : 'waiting');
  });
  stream.addEventListener('location', (event) => addPoint(JSON.parse(event.data)));
  stream.addEventListener('revoked', (event) => {
    stream.close();
    sharingEnded(JSON.parse(event.data));
  });
  stream.onopen = () => setStatus(S.last ? 'live' : 'waiting');
  stream.onerror = () => {
    // A closed EventSource means the server refused the link. Anything else is a dropped connection, which the browser retries.
    if (stream.readyState === EventSource.CLOSED) invalidLink();
    else setStatus('reconnecting');
  };
}

/** Shows a position. The car glides to new positions, and history is placed at once. */
function addPoint(point, { instant = false } = {}) {
  if (point.id <= S.lastId) return;
  S.lastId = point.id;
  const fix = {
    lat: point.lat,
    lng: point.lng,
    accuracy: point.accuracy,
    speed: point.speed,
    time: new Date(point.timestamp),
  };
  const prev = S.last;
  S.last = fix;

  const now = performance.now();
  const deltaMs = S.lastFixTime ? now - S.lastFixTime : 1000;
  S.lastFixTime = now;
  const glideDuration = instant ? 0 : Math.min(Math.max(deltaMs, 350), 2500);

  if (!S.car) {
    const markerColor = params.get('color') || getMarkerColor();
    const markerType = params.get('type') || getMarkerType();
    S.car = new CarMarker(S.map, fix, { color: markerColor, type: markerType });
    S.glider.place(fix);
    S.map.setZoom(16, { animate: false });
    centreOn(S.map, fix, { cover: coverEl() });
    setFollow(true);
  } else {
    if (typeof point.heading === 'number' && !isNaN(point.heading)) {
      S.car.setHeading(point.heading);
    } else if (prev && distanceM(prev, fix) >= 3) {
      S.car.setHeading(bearingDeg(prev, fix));
    }
    if (instant) S.glider.place(fix);
    else S.glider.glideTo(fix, glideDuration);
  }

  updateAccuracyHalo(fix);

  S.trail.push([fix.lat, fix.lng]);
  if (S.trail.length > TRAIL_LENGTH) S.trail.shift();
  drawTrail({ lat: fix.lat, lng: fix.lng }, true);
  renderReadings(fix);
  setStatus('live');
}

function updateAccuracyHalo(fix) {
  if (!S.map || !fix) return;
  const radius = Math.max(fix.accuracy ?? 15, 3);
  if (!S.accuracyHalo) {
    S.accuracyHalo = L.circle([fix.lat, fix.lng], {
      radius,
      color: '#a855f7',
      weight: 1.2,
      opacity: 0.45,
      fillColor: '#a855f7',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(S.map);
  } else {
    S.accuracyHalo.setLatLng([fix.lat, fix.lng]);
    S.accuracyHalo.setRadius(radius);
  }
}

/** Called on every animation frame while the car glides. */
function onFrame(point) {
  S.car.setLatLng(point);
  if (S.accuracyHalo) S.accuracyHalo.setLatLng([point.lat, point.lng]);
  if (S.follow) centreOn(S.map, point, { cover: coverEl() });
  drawTrail(point, false);
}

function drawTrail(head, force) {
  const now = performance.now();
  if (!force && now - S.lastDraw < TRAIL_REDRAW_MS) return;
  S.lastDraw = now;
  S.trailLine.setLatLngs([...S.trail, [head.lat, head.lng]]);
}

function renderReadings(fix) {
  els.lat.textContent = formatCoord(fix.lat);
  els.lng.textContent = formatCoord(fix.lng);
  els.acc.textContent = formatAccuracy(fix.accuracy);
  els.speed.textContent = formatSpeedKmh(fix.speed); const sn = document.getElementById('hud-speed-num'); if (sn) sn.textContent = fix.speed ? Math.round(fix.speed * 3.6) : '0';
  els.clock.textContent = formatClock(fix.time);
}

function setFollow(on) {
  S.follow = on;
  els.follow.setAttribute('aria-pressed', String(on));
  els.free.setAttribute('aria-pressed', String(!on));
  if (on && S.map && S.glider.position) centreOn(S.map, S.glider.position, { cover: coverEl(), animate: true });
}

function sharingEnded(data) {
  setStatus('ended');
  const resetByOwner = /share link/.test(data?.reason ?? '');
  els.banner.textContent = resetByOwner
    ? 'The owner reset this link. Ask for a new one.'
    : 'The owner has stopped sharing this location.';
  els.banner.dataset.tone = 'error';
  els.banner.hidden = false;
}

function invalidLink() {
  S.stream?.close();
  setStatus('invalid');
  els.messageTitle.textContent = 'This link no longer works';
  els.messageText.textContent =
    'The owner may have reset the link or revoked the key. Ask them for a new share link.';
  els.message.hidden = false;
}

function updateViewerVehicleStyle() {
  if (S.car) {
    const color = params.get('color') || getMarkerColor();
    const type = params.get('type') || getMarkerType();
    S.car.setStyle({ color, type });
  }
}

window.addEventListener('storage', updateViewerVehicleStyle);
window.addEventListener('focus', updateViewerVehicleStyle);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') updateViewerVehicleStyle();
});

if (!sessionId || !share) {
  setStatus('invalid');
  els.messageTitle.textContent = 'This link is incomplete';
  els.messageText.textContent = 'Ask the person who shared it for a new link.';
  els.message.hidden = false;
} else {
  start();
}
