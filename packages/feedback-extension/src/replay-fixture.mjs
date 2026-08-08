// A replay fixture is deliberately narrower than a feedback export: it holds
// reviewed rrweb sidecars only. Network/console/error payloads and user text
// never enter the deterministic browser-fixture path.
const sensitive = /(?:password|token|secret|cookie|authorization|email|phone|value)/i;
function redact(value, key = "") {
  if (sensitive.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

export function createReplayFixtureEnvelope(records) {
  const entries = [];
  for (const record of records ?? []) {
    const bundle = record?.bundle;
    if (!bundle?.reviewed || !bundle?.idempotencyKey) continue;
    const approved = new Set((bundle.evidence ?? []).filter((item) => item.kind === "replay" && item.uploadApproved).map((item) => item.digest));
    const replay = (record.sidecars ?? []).filter((sidecar) => approved.has(sidecar.digest));
    if (replay.length !== approved.size) throw new Error(`replay fixture: missing approved replay sidecar for ${bundle.idempotencyKey}`);
    entries.push({
      idempotencyKey: bundle.idempotencyKey,
      anchor: { producer: bundle.anchor?.producer, artifactId: bundle.anchor?.artifactId },
      replay: replay.map((sidecar) => ({ digest: sidecar.digest, payload: redact(sidecar.payload) })),
    });
  }
  return { schema: "sassfully/replay-fixture/v1", entries };
}

export function extractReplayControls(envelope) {
  if (envelope?.schema !== "sassfully/replay-fixture/v1") throw new Error("replay fixture: unsupported envelope");
  const controls = [];
  const visit = (node, timestamp) => {
    if (!node || typeof node !== "object") return;
    const attributes = node.attributes ?? {};
    const label = attributes["aria-label"] ?? attributes.placeholder;
    if (node.tagName === "input" && label) controls.push({ label, timestamp });
    for (const child of node.childNodes ?? []) visit(child, timestamp);
  };
  for (const entry of envelope.entries ?? []) for (const sidecar of entry.replay ?? []) {
    const events = sidecar.payload?.events ?? sidecar.payload ?? [];
    for (const event of Array.isArray(events) ? events : []) visit(event?.data?.node, event?.timestamp ?? null);
  }
  return controls;
}
