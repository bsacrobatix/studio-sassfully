// Reviewed bundle routing plus bundle-first, opt-in sidecar transport.
function memorySink(id) {
  const bundles = []; const blobs = new Map();
  return {
    id, bundles, blobs,
    async submit(bundle) { bundles.push(bundle); return { ref: bundle.idempotencyKey }; },
    async uploadEvidence(bundle, item) { blobs.set(`${bundle.idempotencyKey}:${item.digest}`, item.payload); return { digest: item.digest, status: "uploaded" }; },
  };
}
export function localJsonlSink({ append, erase, replaceEvidence } = {}) {
  const sink = memorySink("local-jsonl"); const { bundles, blobs } = sink; const lines = [];
  return { ...sink, lines, bundles, blobs,
    async submit(bundle) { const line = JSON.stringify(bundle); lines.push(line); if (append) await append(line); return { ref: bundle.idempotencyKey }; },
    async erase(id, reason) { if (erase) return erase(id, reason); const i = lines.findIndex((l) => JSON.parse(l).idempotencyKey === id); if (i >= 0) lines.splice(i, 1, JSON.stringify({ erased: id, reason })); return { erased: id }; },
    async replaceEvidence(id, bundle) { if (replaceEvidence) return replaceEvidence(id, bundle); const i = lines.findIndex((l) => JSON.parse(l).idempotencyKey === id); if (i >= 0) lines[i] = JSON.stringify(bundle); return { replaced: id }; },
  };
}
export function bundleSink() { return memorySink("bundle"); }
export function dryRunSink() { const sink = memorySink("dry-run"); return { ...sink, seen: [], async submit(bundle) { this.seen.push(bundle.idempotencyKey); return { ref: `dry-${bundle.idempotencyKey}` }; } }; }
export function httpSink({ url, evidenceUrl, fetch = globalThis.fetch } = {}) {
  if (!url || typeof url !== "string") throw new TypeError("httpSink: url (string) is required"); if (typeof fetch !== "function") throw new TypeError("httpSink: fetch function is required");
  return { id: "http", async submit(bundle) { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bundle) }); if (!response.ok) throw new Error(`httpSink: POST ${url} failed (${response.status})`); const receipt = await response.json(); if (!receipt || typeof receipt.ref !== "string") throw new Error("httpSink: response must contain a string ref"); return receipt; },
    async uploadEvidence(bundle, item) { if (!evidenceUrl) return { digest: item.digest, status: "skipped", reason: "unsupported-sink" }; const envelope = { $schema: "sassfully/feedback-sidecar-envelope/v1", version: 1, bundleFirst: true, idempotencyKey: bundle.idempotencyKey, digest: item.digest, ...(item.contentType === undefined ? {} : { contentType: item.contentType }), size: item.size, ...(item.transport === undefined ? {} : { transport: item.transport }), payload: item.payload }; const response = await fetch(evidenceUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }); if (!response.ok) throw new Error(`httpSink: POST ${evidenceUrl} failed (${response.status})`); return { ...(await response.json()), digest: item.digest, status: "uploaded" }; },
  };
}
export function createRouter({ sinks, route }) {
  const byId = new Map(sinks.map((s) => [s.id, s])); const settled = new Map(); const sidecars = new Map();
  const select = (bundle) => { const existing = settled.get(bundle.idempotencyKey); if (existing) return byId.get(existing.sink); const sinkId = route ? route(bundle.kind) : sinks[0]?.id; const sink = byId.get(sinkId); if (!sink) throw new Error(`router: no sink ${sinkId}`); return sink; };
  return { async submit(bundle) { if (!bundle?.reviewed) throw new Error("router: refusing non-reviewed payload"); if (settled.has(bundle.idempotencyKey)) return { ...settled.get(bundle.idempotencyKey), deduped: true }; const sink = select(bundle); const receipt = { ...(await sink.submit(bundle)), sink: sink.id, deduped: false }; settled.set(bundle.idempotencyKey, receipt); return receipt; },
    async uploadEvidence(bundle, item) { if (!settled.has(bundle?.idempotencyKey)) throw new Error("router: bundle receipt required before sidecar"); const key = `${bundle.idempotencyKey}:${item.digest}`; if (sidecars.has(key)) return { ...sidecars.get(key), deduped: true }; const sink = select(bundle); if (typeof sink.uploadEvidence !== "function") return { digest: item.digest, status: "skipped", reason: "unsupported-sink" }; const result = await sink.uploadEvidence(bundle, item); if (result.status !== "failed") sidecars.set(key, result); return result; },
  };
}
