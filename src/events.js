/**
 * Seq-addressed event lookup for any session-shaped value.
 *
 * `session.events[seq]` is only correct when that array is dense and starts at
 * seq 0. A persisted session log begins with a header record that carries no
 * `seq`, so every raw-log reader was off by one and every recall silently
 * reported "not found in this session" — including on the first real log it was
 * pointed at. This module resolves by the event's own `seq`, preferring the
 * session's own accessor.
 *
 * @module dsh-compaction-lcm/events
 */

/** Cache of seq → event maps, keyed by the events array identity. */
const mapCache = new WeakMap();

/**
 * Build (and cache) a seq-indexed view of one events array.
 * @param events - session events in log order.
 * @returns the seq → event map.
 */
function seqMap(events) {
  let map = mapCache.get(events);
  if (map === undefined) {
    map = new Map();
    for (const event of events) {
      if (Number.isSafeInteger(event?.seq)) map.set(event.seq, event);
    }
    mapCache.set(events, map);
  }
  return map;
}

/**
 * Resolve one event by its sequence number.
 * @param session - session-shaped value with `events` and optionally `eventAt`.
 * @param seq - the event sequence number.
 * @returns the event, or undefined when absent.
 */
export function resolveEventAt(session, seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  if (typeof session?.eventAt === "function") {
    const event = session.eventAt(seq);
    if (event !== undefined) return event;
  }
  const events = session?.events;
  if (!Array.isArray(events)) return undefined;
  return seqMap(events).get(seq);
}
