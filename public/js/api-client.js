// Fetch wrapper for the Live Track API. The pages are served by the same origin, so relative URLs work.

/** An API failure. `status` is 0 when the server could not be reached at all. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Calls the API and returns the parsed JSON. Throws ApiError with the server's message on failure.
 * @param {string} path      e.g. '/api/location/latest?session_id=...'
 * @param {object} [options] method, apiKey (sent as x-api-key), body (sent as JSON)
 */
export async function api(path, { method = 'GET', apiKey, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Could not reach the Live Track server. Check your connection and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed with status ${res.status}`);
  return data;
}
