// Columbus Live Tracking: clean roundish UI/UX, automatic compass, free positioning,
// custom vehicle marker & pointer colors, typeahead autocomplete, and Supabase cloud sync.
import {
  angleDelta,
  bearingDeg,
  distanceM,
  formatAccuracy,
  formatClock,
  formatCoord,
  formatDistance,
  formatDuration,
  formatSpeedKmh,
  hasArrived,
  nearestVertex,
  polylineLength,
  speedBetween,
  STRAIGHT_LINE_KMH,
} from './geo.js';
import { CarMarker, Glider, getMarkerSvg, COLOR_THEMES } from './car.js';
import { centreOn, createMap, pinIcon } from './map.js';
import { searchPlaces, searchSuggestions } from './nominatim.js';
import { fetchRoute, straightRoute } from './osrm.js';
import { api, ApiError } from './api-client.js';
import { getSession, readStore, setSession, writeStore, getMarkerColor, getMarkerType } from './store.js';
import { $ } from './common.js';

const READ_INTERVAL_MS = 1000;
const TRAIL_LENGTH = 100;
const MAX_QUEUE = 200;
const OFF_ROUTE_M = 60;
const ROUTE_RETRY_MS = 20_000;
const GPS_OPTIONS = { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 };
const MAX_ACCURACY_THRESHOLD_M = 45;
const STATIONARY_SPEED_THRESHOLD_MS = 0.8;
const STATIONARY_DISTANCE_DEADBAND_M = 2.5;
const MIN_DISTANCE_FOR_HEADING_CALC_M = 3.0;
const MAX_REALISTIC_SPEED_MS = 70;
const BANNER_MS = 6_000;
const TAP_LABEL = 'Destination Pin';

const SUPABASE_URL = 'https://fdupudjnsxrwldzsukfn.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZkdXB1ZGpuc3hyd2xkenN1a2ZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0ODU3ODgsImV4cCI6MjEwODA2MTc4OH0.GFYWg-Dm2eHERz9OI-XA3LezWNAWbAAtmEMOgSJ9_C8';

const coverEl = () => (window.matchMedia('(min-width: 900px)').matches ? null : els.sheet);

const MESSAGES = {
  busy: 'Locating GPS position…',
  blocked: 'Location access is disabled. Please allow location in your browser settings.',
  unavailable: 'Could not obtain a GPS fix. Please ensure Location Services are active with sky view.',
  timeout: 'GPS timed out. Re-acquiring position…',
};

const els = {
  gate: $('#gate'),
  allow: $('#allow-gps'),
  gateStatus: $('#gate-status'),
  app: $('#app'),
  search: $('#search-form'),
  searchInput: $('#search-input'),
  results: $('#results'),
  banner: $('#banner'),
  sheet: $('#sheet'),
  sheetToggle: $('#sheet-toggle'),
  status: $('#status'),
  statusText: $('#status-text'),
  follow: $('#mode-follow'),
  free: $('#mode-free'),
  tripDistance: $('#trip-distance'),
  tripTime: $('#trip-time'),
  tripOdometer: $('#trip-odometer'),
  tripTimer: $('#trip-timer'),
  tripNote: $('#trip-note'),
  lat: $('#lat'),
  lng: $('#lng'),
  acc: $('#acc'),
  speed: $('#speed'),
  alt: $('#alt'),
  updated: $('#updated'),
  fill: $('#countdown-fill'),
  clearB: $('#clear-b'),
  stop: $('#stop-btn'),
  resume: $('#resume-btn'),
  toggleTrail: $('#toggle-trail'),
  hudSpeedNum: $('#hud-speed-num'),
  hudSpeedUnit: $('#hud-speed-unit'),
  hudCompass: $('#hud-compass'),
  hudCompassRose: $('#hud-compass-rose'),
  hudCompassText: $('#hud-compass-text'),
  btnLocateMe: $('#btn-locate-me'),
  batteryLevel: $('#battery-level'),
  supabaseStatusText: $('#supabase-status-text'),
  locationBanner: $('#location-banner'),
  locationBannerText: $('#location-banner-text'),
  shareDialog: $('#share-dialog'),
  btnOpenShare: $('#btn-open-share'),
  btnCloseModal: $('#btn-close-modal'),
  shareLinkInput: $('#share-link-input'),
  btnCopyShareModal: $('#btn-copy-share-modal'),
  btnWhatsappShare: $('#btn-whatsapp-share'),
  liveDot: $('#live-dot'),
  liveText: $('#live-text'),
};

const S = {
  status: 'idle',
  waiting: false,
  run: 0,
  starting: false,
  fix: null,
  prevFix: null,
  destination: readStore().destination ?? null,
  searchResults: [],
  route: null,
  routeCursor: 0,
  routeSeq: 0,
  routeRequestedAt: 0,
  trail: [],
  trailVisible: readStore().trailVisible ?? true,
  follow: true,
  timer: null,
  watchId: null,
  lastFixTime: null,
  lastFixReceivedAt: 0,
  lastCloudSyncAt: 0,
  lastCloudSyncFix: null,
  lastCloudSyncHeading: 0,
  nextReadAt: 0,
  readBusy: false,
  queue: [],
  uploading: false,
  wakeLock: null,
  map: null,
  car: null,
  glider: null,
  layers: null,
  lastDraw: 0,
  lastTripDraw: 0,
  speedUnit: readStore().speedUnit ?? 'kmh',
  markerColor: getMarkerColor(),
  markerType: getMarkerType(),
  heading: 0,
  compassAccumAngle: 0,
  totalDistanceM: 0,
  tripStartedAt: null,
  supabaseSyncCount: 0,
};

function init() {
  ensureMap();

  els.allow?.addEventListener('click', beginTracking);
  els.search?.addEventListener('submit', onSearch);
  els.results?.addEventListener('click', onResultClick);

  // Live typeahead autocomplete: guesses 3-4 suggestions as you type letters
  let typeaheadTimer = null;
  els.searchInput?.addEventListener('input', () => {
    clearTimeout(typeaheadTimer);
    const query = els.searchInput.value.trim();
    if (query.length < 2) {
      hideResults();
      return;
    }
    typeaheadTimer = setTimeout(async () => {
      const userPos = S.glider?.position ?? S.fix;
      const suggestions = await searchSuggestions(query, {
        lat: userPos?.lat,
        lng: userPos?.lng,
        limit: 4,
      });
      if (suggestions.length > 0 && els.searchInput.value.trim() === query) {
        showResults(suggestions);
      } else if (suggestions.length === 0) {
        hideResults();
      }
    }, 200);
  });

  document.addEventListener('click', (event) => {
    if (els.search && els.results && !els.search.contains(event.target) && !els.results.contains(event.target)) {
      hideResults();
    }
  });

  els.follow?.addEventListener('click', () => setFollow(true));
  els.free?.addEventListener('click', () => setFollow(false));
  els.btnLocateMe?.addEventListener('click', () => {
    setFollow(true);
    const p = S.glider?.position ?? S.fix;
    if (p && S.map) centreOn(S.map, p, { cover: coverEl(), animate: true });
  });

  els.hudCompass?.addEventListener('click', async () => {
    // Request device orientation permissions if running on iOS Safari 13+
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const granted = await DeviceOrientationEvent.requestPermission();
        if (granted === 'granted') initAutomaticCompass();
      } catch {}
    }
    // Re-center on vehicle and align compass to North
    if (S.map) {
      const p = S.glider?.position ?? S.fix;
      if (p) centreOn(S.map, p, { cover: coverEl(), animate: true });
    }
    updateCompassUi(0);
    notify('Compass aligned North-up', 'info', 2000);
  });

  els.stop?.addEventListener('click', () => stopTracking('user'));
  els.resume?.addEventListener('click', onResumeClick);
  els.clearB?.addEventListener('click', clearDestination);
  els.sheetToggle?.addEventListener('click', toggleSheet);
  els.toggleTrail?.addEventListener('click', onToggleTrail);
  els.hudSpeedUnit?.addEventListener('click', onToggleSpeedUnit);

  els.btnOpenShare?.addEventListener('click', openShareModal);
  els.btnCloseModal?.addEventListener('click', () => els.shareDialog?.close());
  els.btnCopyShareModal?.addEventListener('click', copyShareLink);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.status === 'tracking') acquireWakeLock();
  });

  // Init Device Sensors & vehicle style sync from Settings
  initBattery();
  initAutomaticCompass();
  syncVehicleStyleFromSettings();

  window.addEventListener('storage', syncVehicleStyleFromSettings);
  window.addEventListener('focus', syncVehicleStyleFromSettings);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncVehicleStyleFromSettings();
  });

  // Periodic UI timers
  setInterval(tickReadings, 250);
  setInterval(tickTripTimer, 1000);

  // Auto-start live GPS tracking
  if (!window.isSecureContext) {
    setGate({ message: 'GPS requires HTTPS. See README for tunnel options.', button: 'HTTPS Needed', disabled: true });
  } else if (!('geolocation' in navigator)) {
    setGate({ message: 'Geolocation is not supported by this browser.', disabled: true });
  } else {
    beginTracking();
  }

  renderAll();
}

// ---- Automatic Compass (DeviceOrientation + GPS Motion) ----------------------

function initAutomaticCompass() {
  if (typeof window !== 'undefined' && 'ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
  } else if (typeof window !== 'undefined' && 'ondeviceorientation' in window) {
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
  }
}

function onDeviceOrientation(event) {
  let heading = null;
  if (typeof event.webkitCompassHeading === 'number') {
    heading = event.webkitCompassHeading;
  } else if (event.absolute && typeof event.alpha === 'number') {
    heading = (360 - event.alpha) % 360;
  } else if (typeof event.alpha === 'number') {
    heading = (360 - event.alpha) % 360;
  }
  if (heading !== null && !isNaN(heading)) {
    updateCompassUi(heading);
    const speedKmh = (S.fix?.speed ?? 0) * 3.6;
    if (speedKmh < 2 && S.car) {
      S.heading = heading;
      S.car.setHeading(heading);
    }
  }
}

function updateCompassUi(deg) {
  if (deg === null || deg === undefined || isNaN(deg)) return;
  const rounded = Math.round((deg %= 360) < 0 ? deg + 360 : deg);
  const cardinal = getCardinal(rounded);
  S.compassAccumAngle += angleDelta(S.compassAccumAngle, rounded);
  if (els.hudCompassRose) els.hudCompassRose.style.transform = `rotate(${S.compassAccumAngle.toFixed(1)}deg)`;
  if (els.hudCompassText) els.hudCompassText.textContent = `${cardinal} ${rounded}°`;
}

// ---- Vehicle Appearance Synchronization from Settings -----------------------

function syncVehicleStyleFromSettings() {
  const color = getMarkerColor();
  const type = getMarkerType();
  if (color !== S.markerColor || type !== S.markerType) {
    S.markerColor = color;
    S.markerType = type;
    S.car?.setStyle({ color: S.markerColor, type: S.markerType });
  }
}

function initBattery() {
  if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
    navigator
      .getBattery()
      .then((battery) => {
        const update = () => {
          const level = Math.round(battery.level * 100);
          if (els.batteryLevel) {
            els.batteryLevel.textContent = `${level}%${battery.charging ? ' ⚡' : ''}`;
          }
        };
        update();
        battery.addEventListener('levelchange', update);
        battery.addEventListener('chargingchange', update);
      })
      .catch(() => {});
  }
}

// ---- Floating Gate Banner ---------------------------------------------------

function showGateScreen(visible) {
  if (els.locationBanner) els.locationBanner.hidden = !visible;
  if (els.gate) els.gate.hidden = true;
  if (els.app) els.app.hidden = false;
  if (S.map) S.map.invalidateSize();
}

function setGate({ message = '', button = 'Start GPS', disabled = false, busy = false } = {}) {
  showGateScreen(true);
  if (els.locationBannerText) els.locationBannerText.textContent = message || MESSAGES.busy;
  if (els.allow) {
    els.allow.textContent = button;
    els.allow.disabled = disabled || busy;
    els.allow.setAttribute('aria-busy', String(busy));
  }
  if (els.gateStatus) els.gateStatus.textContent = message;
}

function beginTracking() {
  if (S.starting) return;
  if (!window.isSecureContext) {
    return setGate({ message: 'HTTPS required for GPS', disabled: true });
  }
  if (!('geolocation' in navigator)) {
    return setGate({ message: 'Geolocation unsupported', disabled: true });
  }
  S.starting = true;
  setGate({ message: MESSAGES.busy, busy: true });

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      try {
        await ensureSession();
      } catch (err) {
        S.starting = false;
        setGate({ message: err.message, button: 'Retry' });
        return;
      }
      S.starting = false;
      showGateScreen(false);
      startRun(position);
    },
    (error) => {
      S.starting = false;
      if (error.code === 1) setGate({ message: MESSAGES.blocked, button: 'Enable in Settings' });
      else if (error.code === 2) setGate({ message: MESSAGES.unavailable, button: 'Retry GPS' });
      else setGate({ message: MESSAGES.timeout, button: 'Retry GPS' });
    },
    GPS_OPTIONS,
  );
}

async function ensureSession() {
  const stored = getSession();
  if (stored) {
    try {
      await api(`/api/session/${encodeURIComponent(stored.id)}`, { apiKey: stored.apiKey });
      return stored;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw new ApiError(401, 'API key was revoked. Open Settings to generate a new key.');
      }
      return stored;
    }
  }
  const created = await api('/api/sessions', { method: 'POST' });
  const session = {
    id: created.session_id,
    apiKey: created.api_key,
    shareToken: created.share_token,
    createdAt: created.created_at,
  };
  setSession(session);
  return session;
}

// ---- Tracking Run ------------------------------------------------------------

function startRun(position) {
  const fix = toFix(position);
  S.run += 1;
  const run = S.run;
  S.status = 'tracking';
  S.waiting = false;
  S.fix = fix;
  S.prevFix = null;
  S.lastFixTime = performance.now();
  S.lastFixReceivedAt = Date.now();
  S.lastCloudSyncAt = 0;
  S.lastCloudSyncFix = null;
  S.lastCloudSyncHeading = 0;
  S.trail = [[fix.lat, fix.lng]];
  S.route = null;
  S.routeCursor = 0;
  S.totalDistanceM = 0;
  S.tripStartedAt = Date.now();
  showGateScreen(false);

  ensureMap();
  S.map.setView([fix.lat, fix.lng], 16, { animate: false });
  if (!S.car) {
    S.car = new CarMarker(S.map, fix, { color: S.markerColor, type: S.markerType });
  } else {
    S.car.setLatLng(fix);
  }

  S.layers.a.setLatLng([fix.lat, fix.lng]).addTo(S.map);
  S.glider.place(fix);
  updateAccuracyHalo(fix);

  enqueue(fix);
  acquireWakeLock();
  refreshRouteIfNeeded(fix);
  renderAll();

  startGpsWatch(run);
}

function stopTracking(reason) {
  S.run += 1;
  S.status = reason === 'arrived' ? 'arrived' : 'stopped';
  S.waiting = false;
  if (S.watchId !== null) {
    navigator.geolocation.clearWatch(S.watchId);
    S.watchId = null;
  }
  clearTimeout(S.timer);
  S.timer = null;
  S.glider?.stop();
  if (S.layers?.accuracy) {
    S.layers.accuracy.remove();
    S.layers.accuracy = null;
  }
  releaseWakeLock();
  renderAll();

  if (reason === 'user') notify('Live tracking stopped. Tap Resume when ready.', 'info');
  else if (reason === 'revoked') {
    notify('API key was revoked. Generate a new key in Settings.', 'error', 0);
  }
}

function startGpsWatch(run) {
  if (S.watchId !== null) {
    navigator.geolocation.clearWatch(S.watchId);
    S.watchId = null;
  }
  clearTimeout(S.timer);

  S.watchId = navigator.geolocation.watchPosition(
    (position) => {
      if (S.status !== 'tracking' || S.run !== run) return;
      handleFix(position);
      resetGpsWatchdog(run);
    },
    (error) => {
      if (S.status !== 'tracking' || S.run !== run) return;
      onReadFailure(error);
    },
    GPS_OPTIONS,
  );

  resetGpsWatchdog(run);
}

function resetGpsWatchdog(run) {
  clearTimeout(S.timer);
  // Watchdog: fallback ping every 12s if hardware stops streaming
  S.timer = setTimeout(() => {
    if (S.status !== 'tracking' || S.run !== run) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (S.status === 'tracking' && S.run === run) {
          handleFix(pos);
          resetGpsWatchdog(run);
        }
      },
      () => {},
      GPS_OPTIONS,
    );
  }, 12_000);
}

function onReadFailure(error) {
  S.waiting = true;
  renderStatus();
  if (error.code === 1) {
    stopTracking('denied');
    setGate({ message: MESSAGES.blocked, button: 'Allow in Settings' });
  } else if (error.code === 2) {
    notify('GPS signal lost. Re-acquiring position…', 'warn', 4000);
  } else {
    notify('GPS reading timed out. Waiting for next fix…', 'warn', 4000);
  }
}

function handleFix(position) {
  const fix = toFix(position);
  const prev = S.fix;
  const now = performance.now();
  S.lastFixReceivedAt = Date.now();

  // 1. Accuracy Gate / Outlier Rejection:
  // If we already have a fix, ignore fixes with degraded accuracy (> 45m)
  if (prev && fix.accuracy !== null) {
    if (fix.accuracy > MAX_ACCURACY_THRESHOLD_M) {
      if (els.acc) els.acc.textContent = formatAccuracy(fix.accuracy);
      if (els.updated) els.updated.textContent = formatClock(fix.receivedAt);
      return;
    }

    const elapsedS = Math.max(0.1, (fix.time.getTime() - prev.time.getTime()) / 1000);
    const dist = distanceM(prev, fix);

    // Speed sanity check (teleportation rejection)
    if (elapsedS > 0) {
      const calcSpeed = dist / elapsedS;
      if (calcSpeed > MAX_REALISTIC_SPEED_MS && fix.accuracy > 15) {
        return;
      }
    }
  }

  S.waiting = false;
  renderStatus();

  let isStationary = false;
  if (prev) {
    const elapsedS = Math.max(0.1, (fix.time.getTime() - prev.time.getTime()) / 1000);
    const dist = distanceM(prev, fix);
    const rawSpeed = fix.speed ?? (dist / elapsedS);
    fix.estimatedSpeed = dist / elapsedS;

    // 2. Stationary Jitter Suppression & Deadband:
    // If movement < 2.5m or speed is low & distance < 4m, suppress micro-jitter
    if (dist < STATIONARY_DISTANCE_DEADBAND_M || (rawSpeed < STATIONARY_SPEED_THRESHOLD_MS && dist < 4.0)) {
      isStationary = true;
      fix.speed = 0;
      fix.estimatedSpeed = 0;
    } else {
      S.totalDistanceM += dist;
    }

    // 3. Heading Calculation:
    // Only update heading when moving, avoiding erratic spinning when stationary
    if (!isStationary) {
      const hasHardwareHeading =
        typeof position.coords.heading === 'number' &&
        !isNaN(position.coords.heading) &&
        position.coords.heading >= 0;
      if (hasHardwareHeading && rawSpeed > 1.0) {
        S.heading = position.coords.heading;
      } else if (dist >= MIN_DISTANCE_FOR_HEADING_CALC_M) {
        S.heading = bearingDeg(prev, fix);
      }
      S.car?.setHeading(S.heading);
      updateCompassUi(S.heading);
    }
  } else {
    // First fix
    if (
      typeof position.coords.heading === 'number' &&
      !isNaN(position.coords.heading) &&
      position.coords.heading >= 0
    ) {
      S.heading = position.coords.heading;
      S.car?.setHeading(S.heading);
      updateCompassUi(S.heading);
    }
  }

  S.prevFix = prev;
  S.fix = fix;

  // 4. Glider Interpolation:
  // Smoothly glide over actual elapsed time between fixes
  const deltaMs = S.lastFixTime ? now - S.lastFixTime : 1000;
  S.lastFixTime = now;
  const glideDuration = isStationary ? 250 : Math.min(Math.max(deltaMs, 350), 2000);

  if (!isStationary) {
    S.trail.push([fix.lat, fix.lng]);
    if (S.trail.length > TRAIL_LENGTH) S.trail.shift();
  }

  S.glider?.glideTo(fix, glideDuration);

  // 5. Visual Accuracy Halo
  updateAccuracyHalo(fix);

  // 6. Telemetry Enqueue (throttled)
  enqueueThrottled(fix, isStationary);

  if (S.destination && hasArrived(fix, S.destination)) {
    arrive();
    return;
  }

  if (!isStationary) {
    refreshRouteIfNeeded(fix);
  }
  renderAll();
}

function updateAccuracyHalo(fix) {
  if (!S.layers || !S.map || !fix) return;
  const radius = Math.max(fix.accuracy ?? 15, 3);
  if (!S.layers.accuracy) {
    S.layers.accuracy = L.circle([fix.lat, fix.lng], {
      radius,
      color: '#0d9488',
      weight: 1.2,
      opacity: 0.45,
      fillColor: '#0d9488',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(S.map);
  } else {
    S.layers.accuracy.setLatLng([fix.lat, fix.lng]);
    S.layers.accuracy.setRadius(radius);
  }
}

function enqueueThrottled(fix, isStationary) {
  const now = Date.now();
  const lastFix = S.lastCloudSyncFix;
  const timeSinceLastSync = now - S.lastCloudSyncAt;

  let shouldSync = false;
  if (!lastFix) {
    shouldSync = true;
  } else if (timeSinceLastSync >= 3000) {
    shouldSync = true;
  } else if (!isStationary) {
    const dist = distanceM(lastFix, fix);
    const headingDiff = Math.abs(angleDelta(S.lastCloudSyncHeading || 0, S.heading));
    if (dist >= 4.0 || headingDiff >= 15) {
      shouldSync = true;
    }
  }

  if (shouldSync) {
    S.lastCloudSyncAt = now;
    S.lastCloudSyncFix = fix;
    S.lastCloudSyncHeading = S.heading;
    enqueue(fix);
  }
}

function arrive() {
  S.status = 'arrived';
  notify('Arrived at destination!', 'success', 0);
  if (S.fix) enqueue(S.fix);
  stopTracking('arrived');
}

function onResumeClick() {
  if (S.status === 'arrived') {
    clearDestination();
    beginTracking();
    return;
  }
  beginTracking();
}

// ---- Map Setup & Drawing (Simpler Light Combo) ------------------------------

function ensureMap() {
  if (S.map) return;
  const desktop = window.matchMedia('(min-width: 900px)').matches;
  S.map = createMap('map', { zoomControl: desktop, attributionPosition: desktop ? 'bottomright' : 'topleft' });
  
  // When dragging the map, switch smoothly to Free Position mode
  S.map.on('dragstart', () => setFollow(false));
  S.map.on('click', (event) => {
    setDestination({ lat: event.latlng.lat, lng: event.latlng.lng, label: TAP_LABEL });
  });

  const line = { interactive: false, lineCap: 'round', lineJoin: 'round' };
  S.layers = {
    trail: L.polyline([], { ...line, color: '#0d9488', weight: 4, opacity: 0.7 }).addTo(S.map),
    casing: L.polyline([], { ...line, color: '#ffffff', weight: 11, opacity: 0.95 }).addTo(S.map),
    route: L.polyline([], { ...line, color: '#0d9488', weight: 6, opacity: 1 }).addTo(S.map),
    a: L.marker([0, 0], { icon: pinIcon('A', 'start'), interactive: false, keyboard: false, zIndexOffset: 500 }),
    b: L.marker([0, 0], { icon: pinIcon('B', 'end'), interactive: false, keyboard: false, zIndexOffset: 400 }),
    accuracy: null,
  };

  S.glider = new Glider({ onFrame: onGlideFrame });
  showDestinationPin();
}

function onGlideFrame(point, progress) {
  S.car?.setLatLng(point);
  if (S.layers?.accuracy) S.layers.accuracy.setLatLng([point.lat, point.lng]);
  if (S.follow) centreOn(S.map, point, { cover: coverEl() });
  drawLines(point, false);

  const now = performance.now();
  if (progress === 1 || now - S.lastTripDraw > 250) {
    S.lastTripDraw = now;
    renderTrip();
  }
}

function drawLines(point, force) {
  if (!S.layers || !point) return;
  const now = performance.now();
  if (!force && now - S.lastDraw < 100) return;
  S.lastDraw = now;
  const head = [point.lat, point.lng];

  if (S.trailVisible) {
    S.layers.trail.setLatLngs([...S.trail, head]);
  } else {
    S.layers.trail.setLatLngs([]);
  }

  if (S.route && S.destination) {
    const ahead = [head, ...S.route.coords.slice(S.routeCursor)];
    S.layers.casing.setLatLngs(S.route.fallback ? [] : ahead);
    S.layers.route.setLatLngs(ahead);
    S.layers.route.setStyle({ dashArray: S.route.fallback ? '3 10' : null });
  } else {
    S.layers.casing.setLatLngs([]);
    S.layers.route.setLatLngs([]);
  }
}

function showDestinationPin() {
  if (!S.layers || !S.map) return;
  if (S.destination) S.layers.b.setLatLng([S.destination.lat, S.destination.lng]).addTo(S.map);
  else S.layers.b.remove();
}

function setFollow(on) {
  S.follow = on;
  els.follow?.setAttribute('aria-pressed', String(on));
  els.free?.setAttribute('aria-pressed', String(!on));
  if (els.btnLocateMe) {
    els.btnLocateMe.classList.toggle('active', on);
  }
  const p = S.glider?.position;
  if (on && S.map && p) centreOn(S.map, p, { cover: coverEl(), animate: true });
}

function fitTrip() {
  const from = S.glider?.position ?? S.fix;
  if (!S.map || !S.destination || !from) return;
  const bounds = L.latLngBounds([
    [from.lat, from.lng],
    [S.destination.lat, S.destination.lng],
  ]);
  S.map.fitBounds(bounds, {
    paddingTopLeft: [24, 120],
    paddingBottomRight: [24, (els.sheet?.offsetHeight || 180) + 24],
    maxZoom: 17,
  });
}

function setDestination(place) {
  S.destination = place;
  writeStore({ destination: place });
  showDestinationPin();
  els.clearB && (els.clearB.hidden = false);
  const from = S.glider?.position ?? S.fix;
  if (from) {
    S.route = null;
    S.routeCursor = 0;
    fetchAndApplyRoute(from, place);
    fitTrip();
  }
  renderTrip();
}

function clearDestination() {
  S.destination = null;
  S.route = null;
  S.routeCursor = 0;
  writeStore({ destination: null });
  showDestinationPin();
  drawLines(S.glider?.position ?? S.fix, true);
  if (els.clearB) els.clearB.hidden = true;
  renderTrip();
}

async function fetchAndApplyRoute(from, to) {
  S.routeSeq += 1;
  const seq = S.routeSeq;
  S.routeRequestedAt = Date.now();
  const route = await fetchRoute(from, to);
  if (S.routeSeq !== seq || !S.destination) return;
  S.route = route;
  S.routeCursor = nearestVertex(from, route.coords);
  drawLines(from, true);
  renderTrip();
}

function refreshRouteIfNeeded(fix) {
  if (!S.destination) return;
  if (!S.route) {
    fetchAndApplyRoute(fix, S.destination);
    return;
  }
  S.routeCursor = nearestVertex(fix, S.route.coords);
  const nearPoint = S.route.coords[S.routeCursor];
  if (nearPoint) {
    const off = distanceM(fix, { lat: nearPoint[0], lng: nearPoint[1] });
    if (off > OFF_ROUTE_M && Date.now() - S.routeRequestedAt > ROUTE_RETRY_MS) {
      fetchAndApplyRoute(fix, S.destination);
    }
  }
}

// ---- Search & Autocomplete Handlers ------------------------------------------

async function onSearch(event) {
  event.preventDefault();
  const q = els.searchInput.value.trim();
  if (!q) return;
  els.searchInput.blur();
  notify('Searching places…', 'info', 2000);
  try {
    const places = await searchPlaces(q);
    if (places.length === 0) {
      notify('No places found. Try another search.', 'warn');
      return;
    }
    if (places.length === 1) {
      setDestination(places[0]);
      hideResults();
      return;
    }
    showResults(places);
  } catch {
    notify('Search unavailable right now.', 'error');
  }
}

function onResultClick(event) {
  const btn = event.target.closest('button');
  if (!btn) return;
  const index = Number(btn.dataset.index);
  const place = S.searchResults[index];
  if (place) {
    if (els.searchInput) els.searchInput.value = place.name || shortLabel(place.label);
    setDestination(place);
    hideResults();
  }
}

function showResults(places) {
  S.searchResults = places.slice(0, 4);
  els.results.innerHTML = S.searchResults
    .map((p, i) => {
      const name = p.name || shortLabel(p.label);
      const subtext = p.subtext || '';
      return `<li>
        <button type="button" data-index="${i}">
          <span class="res-pin" aria-hidden="true">📍</span>
          <span class="res-text">
            <strong class="res-name">${name}</strong>
            ${subtext ? `<span class="res-sub">${subtext}</span>` : ''}
          </span>
        </button>
      </li>`;
    })
    .join('');
  els.results.hidden = false;
}

function hideResults() {
  if (els.results) els.results.hidden = true;
}

// ---- Cloud Telemetry (Server + Supabase REST Dual Sync) ----------------------

function enqueue(fix) {
  const session = getSession();
  const point = {
    session_id: session?.id || 'columbus_tracker',
    lat: fix.lat,
    lng: fix.lng,
    accuracy: fix.accuracy,
    speed: fix.speed ?? fix.estimatedSpeed ?? 0,
    heading: S.heading || 0,
    timestamp: fix.time.toISOString(),
  };

  S.queue.push(point);
  if (S.queue.length > MAX_QUEUE) S.queue.splice(0, S.queue.length - MAX_QUEUE);
  flushQueue();

  // Dual push directly to Supabase REST
  syncToSupabaseDirect(point);
}

async function flushQueue() {
  if (S.uploading) return;
  S.uploading = true;
  try {
    while (S.queue.length > 0) {
      const session = getSession();
      if (!session) {
        S.queue = [];
        return;
      }
      try {
        await api('/api/location', { method: 'POST', apiKey: session.apiKey, body: S.queue[0] });
        S.queue.shift();
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          S.queue = [];
          stopTracking('revoked');
          return;
        }
        if (err instanceof ApiError && err.status === 400) {
          S.queue.shift();
          continue;
        }
        return;
      }
    }
  } finally {
    S.uploading = false;
  }
}

async function syncToSupabaseDirect(point) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/columbus_locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        session_id: point.session_id,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        speed: point.speed,
        heading: point.heading,
        created_at: point.timestamp,
      }),
    });
    S.supabaseSyncCount += 1;
    if (els.supabaseStatusText) {
      els.supabaseStatusText.textContent = `Supabase (${S.supabaseSyncCount})`;
    }
  } catch {}
}

// ---- WakeLock ----------------------------------------------------------------

async function acquireWakeLock() {
  if (!('wakeLock' in navigator) || S.wakeLock || document.visibilityState !== 'visible') return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => {
      S.wakeLock = null;
    });
  } catch {}
}

function releaseWakeLock() {
  const lock = S.wakeLock;
  S.wakeLock = null;
  lock?.release?.()?.catch?.(() => {});
}

// ---- Rendering & Cockpit HUD -------------------------------------------------

function toFix(position) {
  const c = position.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: typeof c.accuracy === 'number' && !isNaN(c.accuracy) ? c.accuracy : null,
    speed: typeof c.speed === 'number' && !isNaN(c.speed) ? c.speed : null,
    altitude: typeof c.altitude === 'number' && !isNaN(c.altitude) ? c.altitude : null,
    time: new Date(position.timestamp ?? Date.now()),
    receivedAt: new Date(),
    estimatedSpeed: null,
  };
}

const STATUS_TEXT = {
  idle: ['Ready', 'idle'],
  tracking: ['LIVE', 'live'],
  stopped: ['Paused', 'idle'],
  arrived: ['Arrived', 'done'],
};

function renderStatus() {
  let [text, tone] = STATUS_TEXT[S.status] ?? STATUS_TEXT.idle;
  if (S.status === 'tracking' && S.waiting) {
    text = 'Acquiring GPS';
    tone = 'warn';
  }
  if (els.status) {
    els.status.dataset.tone = tone;
    els.statusText.textContent = text;
  }
  if (els.liveText) els.liveText.textContent = text;
  if (els.liveDot) {
    els.liveDot.className = tone === 'live' ? 'live-dot' : 'live-dot idle';
  }
}

function renderButtons() {
  const tracking = S.status === 'tracking';
  const paused = S.status === 'stopped' || S.status === 'arrived';
  if (els.stop) els.stop.hidden = !tracking;
  if (els.resume) {
    els.resume.hidden = !paused;
    els.resume.textContent = S.status === 'arrived' ? 'New Trip' : 'Resume';
  }
  if (els.clearB) els.clearB.hidden = !S.destination;
}

function renderTrip() {
  const destination = S.destination;
  if (!destination) {
    if (els.tripDistance) els.tripDistance.textContent = '–';
    if (els.tripTime) els.tripTime.textContent = '–';
    if (els.tripNote) els.tripNote.textContent = 'Choose point B: search for a place, or tap the map.';
    return;
  }
  const from = S.glider?.position ?? S.fix;
  if (!from) {
    if (els.tripNote) els.tripNote.textContent = 'Waiting for GPS to plan route…';
    return;
  }

  let metres;
  let seconds;
  let note;
  if (S.route && !S.route.fallback) {
    const index = Math.min(S.routeCursor, S.route.coords.length - 1);
    const [lat, lng] = S.route.coords[index];
    metres = distanceM(from, { lat, lng }) + polylineLength(S.route.coords, index);
    seconds = S.route.distance > 0 ? S.route.duration * Math.min(1, metres / S.route.distance) : null;
    note = `Road route to ${shortLabel(destination.label)}`;
  } else {
    metres = distanceM(from, destination);
    seconds = metres / (STRAIGHT_LINE_KMH / 3.6);
    note = S.route ? 'Direct navigation line' : 'Calculating route…';
  }

  if (S.status === 'arrived') {
    metres = distanceM(from, destination);
    seconds = null;
    note = 'You have arrived at your destination.';
  }

  if (els.tripDistance) els.tripDistance.textContent = formatDistance(metres);
  if (els.tripTime) els.tripTime.textContent = seconds === null ? '–' : formatDuration(seconds);
  if (els.tripNote) els.tripNote.textContent = note;
}

function renderReadings() {
  const fix = S.fix;
  if (!fix) return;
  if (els.lat) els.lat.textContent = formatCoord(fix.lat);
  if (els.lng) els.lng.textContent = formatCoord(fix.lng);
  if (els.acc) els.acc.textContent = formatAccuracy(fix.accuracy);
  if (els.alt) els.alt.textContent = fix.altitude ? `${Math.round(fix.altitude)} m` : '–';

  const rawSpeed = fix.speed ?? fix.estimatedSpeed ?? 0;
  const speedKmh = rawSpeed * 3.6;
  const speedMph = rawSpeed * 2.23694;

  const displaySpeed = S.speedUnit === 'mph' ? Math.round(speedMph) : Math.round(speedKmh);
  if (els.hudSpeedNum) els.hudSpeedNum.textContent = String(displaySpeed);
  if (els.hudSpeedUnit) els.hudSpeedUnit.textContent = S.speedUnit.toUpperCase();
  if (els.speed) els.speed.textContent = `${displaySpeed} ${S.speedUnit.toUpperCase()}`;

  // Compass heading
  const deg = Math.round(S.heading);
  updateCompassUi(deg);

  // Odometer
  if (els.tripOdometer) {
    const odoKm = S.totalDistanceM / 1000;
    els.tripOdometer.textContent = S.speedUnit === 'mph'
      ? `${(odoKm * 0.621371).toFixed(1)} mi`
      : `${odoKm.toFixed(1)} km`;
  }

  if (els.updated) els.updated.textContent = formatClock(fix.receivedAt);
}

function tickReadings() {
  if (S.status !== 'tracking') {
    if (els.fill) els.fill.style.transform = 'scaleX(0)';
    return;
  }
  const ageMs = Date.now() - (S.lastFixReceivedAt || Date.now());
  const freshness = Math.max(0, 1 - ageMs / 5000);
  if (els.fill) els.fill.style.transform = `scaleX(${freshness.toFixed(3)})`;
}

function tickTripTimer() {
  if (S.status === 'tracking' && S.tripStartedAt && els.tripTimer) {
    const elapsedS = Math.floor((Date.now() - S.tripStartedAt) / 1000);
    const m = Math.floor(elapsedS / 60);
    const s = elapsedS % 60;
    els.tripTimer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

function getCardinal(deg) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((deg %= 360) < 0 ? deg + 360 : deg) / 45) % 8];
}

function onToggleSpeedUnit() {
  S.speedUnit = S.speedUnit === 'kmh' ? 'mph' : 'kmh';
  writeStore({ speedUnit: S.speedUnit });
  renderReadings();
}

function onToggleTrail() {
  S.trailVisible = !S.trailVisible;
  writeStore({ trailVisible: S.trailVisible });
  if (els.toggleTrail) els.toggleTrail.textContent = `Trail: ${S.trailVisible ? 'On' : 'Off'}`;
  drawLines(S.glider?.position ?? S.fix, true);
}

function renderAll() {
  renderStatus();
  renderButtons();
  renderTrip();
  renderReadings();
}

function toggleSheet() {
  const collapsed = els.sheet?.dataset.collapsed !== 'true';
  if (els.sheet) els.sheet.dataset.collapsed = String(collapsed);
  els.sheetToggle?.setAttribute('aria-expanded', String(!collapsed));
}

function openShareModal() {
  const session = getSession();
  const sessionId = session?.id || '';
  const shareToken = session?.shareToken || '';
  const url = new URL(
    `live.html?session=${encodeURIComponent(sessionId)}&share=${encodeURIComponent(shareToken)}&color=${encodeURIComponent(S.markerColor)}&type=${encodeURIComponent(S.markerType)}`,
    window.location.href,
  ).href;

  if (els.shareLinkInput) els.shareLinkInput.value = url;
  if (els.btnWhatsappShare) {
    els.btnWhatsappShare.href = `https://api.whatsapp.com/send?text=${encodeURIComponent(
      'Track my live location on Columbus: ' + url,
    )}`;
  }
  els.shareDialog?.showModal();
}

async function copyShareLink() {
  const input = els.shareLinkInput;
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    notify('Share link copied to clipboard!', 'success', 3000);
  } catch {
    input.select();
    document.execCommand('copy');
    notify('Link copied!', 'success', 3000);
  }
}

let bannerTimer = null;
function notify(message, tone = 'info', ms = BANNER_MS) {
  clearTimeout(bannerTimer);
  if (!els.banner) return;
  els.banner.textContent = message;
  els.banner.dataset.tone = tone;
  els.banner.hidden = false;
  if (ms > 0) bannerTimer = setTimeout(() => (els.banner.hidden = true), ms);
}

const shortLabel = (label) => String(label).split(',').slice(0, 2).join(',').trim();

init();
