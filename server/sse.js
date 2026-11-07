// Live-update streams (Server-Sent Events), grouped by session.
// Each open connection remembers whether it was opened with an API key or a
// share token, so a share-link reset can end only the read-only viewers.

function send(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createHub() {
  const streams = new Map(); // sessionId -> Map<response, 'key' | 'share'>

  return {
    subscribe(sessionId, res, access) {
      if (!streams.has(sessionId)) streams.set(sessionId, new Map());
      streams.get(sessionId).set(res, access);
    },

    unsubscribe(sessionId, res) {
      const group = streams.get(sessionId);
      if (!group) return;
      group.delete(res);
      if (group.size === 0) streams.delete(sessionId);
    },

    publish(sessionId, event, data) {
      for (const res of streams.get(sessionId)?.keys() ?? []) send(res, event, data);
    },

    /** Sends a final event and ends the matching streams. Without `access`, every stream ends. */
    close(sessionId, { event, data, access = null }) {
      const group = streams.get(sessionId);
      if (!group) return;
      for (const [res, streamAccess] of group) {
        if (access && streamAccess !== access) continue;
        send(res, event, data);
        res.end();
        group.delete(res);
      }
      if (group.size === 0) streams.delete(sessionId);
    },

    /** A comment line every 20 seconds stops proxies and phone networks from closing idle streams. */
    startHeartbeat(intervalMs = 20_000) {
      const timer = setInterval(() => {
        for (const group of streams.values()) {
          for (const res of group.keys()) if (!res.writableEnded) res.write(': ping\n\n');
        }
      }, intervalMs);
      timer.unref();
      return timer;
    },
  };
}
