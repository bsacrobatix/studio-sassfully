// ring.mjs — comp-recording-ring: the bounded local capture ring of
// req-host-policy-gates-evidence / rich-evidence-sidecars, fed by rrweb's
// emit callback. Eviction never removes the newest full-snapshot checkpoint
// (rrweb event type 2, with its immediately preceding Meta type 4), so the
// retained tail is always independently replayable. Snapshots are frozen
// deep copies: attaching evidence freezes; the ring keeps rolling.

const encoder = new TextEncoder();
const sizeOf = (value) => encoder.encode(JSON.stringify(value ?? null)).byteLength;
const FULL_SNAPSHOT = 2;
const META = 4;

export function createRecordingRing({ maxEvents = 5000, maxBytes = 8 * 1024 * 1024 } = {}) {
  let entries = []; let totalBytes = 0;
  const over = () => entries.length > maxEvents || totalBytes > maxBytes;
  const removeRange = (start, end) => { for (const removed of entries.splice(start, end - start)) totalBytes -= removed.bytes; };
  // Length of the protected segment head at the front: [Meta?] FullSnapshot.
  const headLen = () => {
    if (entries[0]?.event?.type === META && entries[1]?.event?.type === FULL_SNAPSHOT) return 2;
    if (entries[0]?.event?.type === FULL_SNAPSHOT) return 1;
    return 0;
  };
  function evict() {
    while (over() && entries.length > 1) {
      // Prefer dropping whole leading segments: scan past the front head for
      // the next checkpoint (pulling in its preceding Meta) and cut there.
      let next = -1;
      for (let i = Math.max(1, headLen()); i < entries.length; i++) {
        if (entries[i].event?.type === FULL_SNAPSHOT) { next = (i > 0 && entries[i - 1].event?.type === META) ? i - 1 : i; break; }
      }
      if (next > 0) { removeRange(0, next); continue; }
      const head = headLen();
      if (head === 0) { removeRange(0, 1); continue; }
      // One checkpointed segment left and still over budget: the hard cap
      // wins — drop its oldest incremental, keeping the snapshot head.
      if (entries.length > head) { removeRange(head, head + 1); continue; }
      break;
    }
  }
  return {
    push(event) {
      if (!event || typeof event !== "object") throw new TypeError("ring: event object required");
      entries.push({ event, bytes: sizeOf(event) });
      totalBytes += entries[entries.length - 1].bytes;
      evict();
    },
    /** Frozen trailing-window copy, starting at the latest checkpoint at or
     * before the window start so the slice replays standalone. */
    snapshot({ lastMs } = {}) {
      if (!entries.length) return Object.freeze({ events: [], startTs: null, endTs: null, byteSize: 0 });
      const endTs = entries[entries.length - 1].event.timestamp ?? null;
      let startIdx = 0;
      if (lastMs != null && endTs != null) {
        const windowStart = endTs - lastMs;
        let checkpoint = -1;
        for (let i = 0; i < entries.length; i++) {
          const event = entries[i].event;
          if (event?.type === FULL_SNAPSHOT && (event.timestamp ?? 0) <= windowStart) checkpoint = i;
        }
        if (checkpoint >= 0) startIdx = (checkpoint > 0 && entries[checkpoint - 1].event?.type === META) ? checkpoint - 1 : checkpoint;
      }
      const slice = entries.slice(startIdx);
      return Object.freeze({
        events: slice.map((entry) => structuredClone(entry.event)),
        startTs: slice[0].event.timestamp ?? null,
        endTs,
        byteSize: slice.reduce((sum, entry) => sum + entry.bytes, 0),
      });
    },
    clear() { entries = []; totalBytes = 0; },
    stats() {
      return {
        events: entries.length,
        bytes: totalBytes,
        checkpoints: entries.filter((entry) => entry.event?.type === FULL_SNAPSHOT).length,
        startTs: entries[0]?.event.timestamp ?? null,
        endTs: entries[entries.length - 1]?.event.timestamp ?? null,
      };
    },
  };
}

/** Split a snapshot into ordered, individually reviewable sidecar items
 * (req-sidecar-chunking). Each item is the exact attachEvidence shape; the
 * chunk budget leaves envelope headroom under the intake's per-sidecar cap. */
export function replayEvidenceItems(snapshot, { maxChunkBytes = 1.5 * 1024 * 1024, clipId } = {}) {
  if (!clipId || typeof clipId !== "string") throw new TypeError("ring: clipId (string) is required");
  if (!snapshot?.events?.length) return [];
  const chunks = [[]];
  let chunkBytes = 0;
  for (const event of snapshot.events) {
    const bytes = sizeOf(event);
    if (chunkBytes + bytes > maxChunkBytes && chunks[chunks.length - 1].length) { chunks.push([]); chunkBytes = 0; }
    chunks[chunks.length - 1].push(event);
    chunkBytes += bytes;
  }
  const of = chunks.length;
  const durationMs = snapshot.startTs != null && snapshot.endTs != null ? snapshot.endTs - snapshot.startTs : null;
  return chunks.map((events, index) => ({
    kind: "replay",
    label: of === 1 ? "Session replay" : `Session replay (chunk ${index + 1}/${of})`,
    snippet: `${events.length} rrweb events${durationMs != null ? `, ${durationMs}ms window` : ""}${of > 1 ? `, chunk ${index + 1}/${of}` : ""}`,
    contentType: "application/json",
    transport: "sidecar-json",
    payload: { $schema: "sassfully/replay-clip/v1", clipId, chunk: index + 1, of, startTs: snapshot.startTs, endTs: snapshot.endTs, events },
  }));
}
