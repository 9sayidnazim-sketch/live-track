// Browser-side storage. Everything here stays on this device.
const KEY = 'livetrack.v1';

export function readStore() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

export function writeStore(patch) {
  const next = { ...readStore(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or disabled (private browsing). The page still works for this visit.
  }
  return next;
}

/** The session this device tracks with: { id, apiKey, shareToken, createdAt }, or null. */
export const getSession = () => readStore().session ?? null;
export const setSession = (session) => writeStore({ session });

export const getMarkerColor = () => readStore().markerColor ?? 'orange';
export const setMarkerColor = (markerColor) => writeStore({ markerColor });

export const getMarkerType = () => readStore().markerType ?? 'car';
export const setMarkerType = (markerType) => writeStore({ markerType });
