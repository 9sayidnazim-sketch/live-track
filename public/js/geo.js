// Geometry and formatting helpers. These are pure functions with no DOM or Leaflet,
// so they can be unit-tested in Node.

export const ARRIVAL_RADIUS_M = 30; // the car counts as arrived within this distance of B...
const ARRIVAL_ACCURACY_CAP_M = 50; // ...or within its GPS accuracy, never more than this
export const STRAIGHT_LINE_KMH = 40; // speed used to estimate time when there is no road route
const EARTH_RADIUS_M = 6371008.8;

const toRad = (degrees) => (degrees * Math.PI) / 180;
const toDeg = (radians) => (radians * 180) / Math.PI;

/** Great-circle distance in metres between two { lat, lng } points. */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, in degrees clockwise from north, in [0, 360). */
export function bearingDeg(a, b) {
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The shortest signed turn from angle `from` to angle `to`, in degrees within [-180, 180). */
export function angleDelta(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpPoint = (a, b, t) => ({ lat: lerp(a.lat, b.lat, t), lng: lerp(a.lng, b.lng, t) });
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const asPoint = ([lat, lng]) => ({ lat, lng });

/** Index and distance of the vertex in coords ([[lat, lng], ...]) nearest to point p. */
export function nearestVertex(coords, p) {
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < coords.length; i += 1) {
    const d = distanceM(asPoint(coords[i]), p);
    if (d < best) {
      best = d;
      index = i;
    }
  }
  return { index, distance: best };
}

/** Length in metres of the polyline coords from index `from` to its end. */
export function polylineLength(coords, from = 0) {
  let total = 0;
  for (let i = Math.max(0, from); i < coords.length - 1; i += 1) {
    total += distanceM(asPoint(coords[i]), asPoint(coords[i + 1]));
  }
  return total;
}

/** Speed in metres per second between two fixes that each carry a `time` Date. Null if it cannot be worked out. */
export function speedBetween(prev, next) {
  const seconds = (next.time - prev.time) / 1000;
  return seconds > 0 ? distanceM(prev, next) / seconds : null;
}

/** True when a fix is close enough to point B to count as arrived. */
export function hasArrived(fix, destination) {
  const allowance = Math.min(ARRIVAL_ACCURACY_CAP_M, Math.max(0, fix.accuracy ?? 0));
  return distanceM(fix, destination) <= Math.max(ARRIVAL_RADIUS_M, allowance);
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '-';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '-';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export const formatSpeedKmh = (metresPerSecond) =>
  Number.isFinite(metresPerSecond) ? `${Math.round(metresPerSecond * 3.6)} km/h` : '-';
export const formatCoord = (value) => (Number.isFinite(value) ? value.toFixed(6) : '-');
export const formatAccuracy = (metres) => (Number.isFinite(metres) ? `${Math.round(metres)} m` : '-');

const pad = (n) => String(n).padStart(2, '0');

/** Local time as HH:MM:SS. */
export const formatClock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
