// export.mjs — file export of the local store: bundle JSONL matching the
// intake's ledger lines, plus one file per stored sidecar under the intake's
// own evidence/<key>/<digest> layout so an export drops into the same tools.

export function exportBundles(records) {
  const rows = (Array.isArray(records) ? records : []).filter((record) => record?.bundle);
  return {
    jsonl: rows.length ? rows.map((record) => JSON.stringify(record.bundle)).join("\n") + "\n" : "",
    sidecarFiles: rows.flatMap((record) => (record.sidecars ?? []).map((sidecar) => ({
      name: `evidence/${record.bundle.idempotencyKey}/${sidecar.digest}.json`,
      body: JSON.stringify(sidecar.payload),
    }))),
  };
}

export { createReplayFixtureEnvelope } from "./replay-fixture.mjs";

export async function exportStore(store) { return exportBundles(await store.list()); }
