import test from "node:test";
import assert from "node:assert/strict";
import { authorTour, captureBrowserEvidence, exportTour, replayTour } from "../src/index.mjs";
const tour = { version: 2, id: "fixture", steps: [{ id: "open", kind: "highlight", target: { testid: "open" } }] };
test("captures only opted-in classified browser evidence", async () => { const driver = { capture: async () => ({ dom: { label: "neutral" } }) }; assert.equal((await captureBrowserEvidence(driver)).captured, false); await assert.rejects(captureBrowserEvidence(driver, { optIn: true }), /unclassified/); const evidence = await captureBrowserEvidence(driver, { optIn: true, classifications: { "dom.label": "public" } }); assert.equal(evidence.captured, true); });
test("authors, exports and replays deterministically through an injected driver", async () => { const manifest = authorTour(tour); assert.equal(JSON.parse(exportTour(manifest)).id, "fixture"); const result = await replayTour(manifest, { driver: { find: async () => [{}], highlight: async () => {} } }); assert.equal(result.events[0].stepId, "open"); });
