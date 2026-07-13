import test from "node:test";
import assert from "node:assert/strict";
import { playTour } from "../src/index.mjs";
const manifest = { version: 2, id: "t", origin: "https://example.test", steps: [{ id: "a", kind: "highlight", target: { testid: "gone", role: "button", name: "Start" } }, { id: "b", kind: "act", act: { kind: "click" }, target: { testid: "start" } }] };
const driver = { origin: () => "https://example.test", find: async (a) => a._strategy === "role" ? [] : [a], highlight: async () => {}, act: async () => {} };
test("records an audited semantic heal and only acts after consent", async () => { const result = await playTour(manifest, { driver, consent: async () => true }); assert.deepEqual(result.events.map((e) => e.type), ["heal", "highlight", "act"]); assert.equal(result.events[0].matchedAnchor, "testid"); });
test("rejects ambiguity, origin mismatch, and denied actions", async () => { await assert.rejects(playTour(manifest, { driver: { ...driver, find: async () => [{}, {}] }, consent: async () => true }), /ambiguous/); await assert.rejects(playTour(manifest, { driver: { ...driver, origin: () => "https://wrong.test" } }), /origin/); await assert.rejects(playTour(manifest, { driver, consent: async () => false }), /consent denied/); });
