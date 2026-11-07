// Road routing with Columbus backend proxy (fallback to direct demo server).
import { distanceM, STRAIGHT_LINE_KMH } from './geo.js';

const BASE =
  typeof window !== 'undefined'
    ? '/route/v1/driving'
    : 'https://router.project-osrm.org/route/v1/driving';

export function straightRoute(from, to) {
  const distance = distanceM(from, to);
  return {
    coords: [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ],
    distance,
    duration: distance / (STRAIGHT_LINE_KMH / 3.6),
    fallback: true,
  };
}

export async function fetchRoute(from, to, { timeoutMs = 10_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${BASE}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`Routing failed with status ${res.status}`);
    const data = await res.json();
    const route = data.routes?.[0];
    if (data.code !== 'Ok' || !route) throw new Error(`Routing returned ${data.code ?? 'no route'}`);
    return {
      coords: route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
      distance: route.distance,
      duration: route.duration,
      fallback: false,
    };
  } catch {
    return straightRoute(from, to);
  } finally {
    clearTimeout(timer);
  }
}
