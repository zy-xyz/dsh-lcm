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
 * @module dsh-lcm/events
 */

/** Cache of seq → event maps, keyed by the events array identity. */
const mapCache = new WeakMap();

/**
 * Read one session's events through whichever accessor it actually exposes.
 *
 * A real dsh `Session` has no `events` property: it owns an append-only `log`
 * and the frozen `snapshotEvents()` accessor. Reading `session.events` therefore
 * threw on the first real session it met — every automatic compaction, search
 * and recall died on `undefined`, which the `events`-carrying test fixtures
 * never showed. The array form stays first so fixtures and older callers keep
 * working unchanged.
 *
 * `snapshotEvents()` returns a frozen copy, so callers must take it once into a
 * local instead of calling this accessor inside a loop.
 * @param session - session-shaped value.
 * @returns the event array; empty when the value carries none.
 */
export function sessionEvents(session) {
  if (session === null || session === undefined) return [];
  if (Array.isArray(session.events)) return session.events;
  if (typeof session.snapshotEvents === "function") {
    const snapshot = session.snapshotEvents();
    if (Array.isArray(snapshot)) return snapshot;
  }
  if (Array.isArray(session.log)) return session.log;
  return [];
}

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
  // `events` first, so the fixture shape needs no snapshot; anything that only
  // exposes `snapshotEvents()`/`log` still resolves (the accessor is one copy).
  const events = sessionEvents(session);
  if (events.length === 0) return undefined;
  return seqMap(events).get(seq);
}
