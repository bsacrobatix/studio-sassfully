import test from "node:test";
import assert from "node:assert/strict";
import { validateTourManifestV2, convertTourManifestV1 } from "../src/index.mjs";
const base = { version: 2, id: "synthetic-welcome", origin: "https://example.test", steps: [{ id: "welcome", kind: "highlight", target: [{ role: "button", name: "Start" }, { testid: "start" }], title: "Start" }] };
test("validates defaults and ranked anchors", () => { const tour = validateTourManifestV2(base); assert.deepEqual(tour.steps[0].advanceOn, []); assert.equal(tour.steps[0].target.length, 2); });
test("rejects unknown fields, duplicate ids, and weak anchors", () => { assert.throws(() => validateTourManifestV2({ ...base, extra: true })); assert.throws(() => validateTourManifestV2({ ...base, steps: [base.steps[0], { ...base.steps[0] }] })); assert.throws(() => validateTourManifestV2({ ...base, steps: [{ ...base.steps[0], target: {} }] })); });
test("upgrades v1 and defaults act consent to confirm", () => { const upgraded = convertTourManifestV1({ id: "old", steps: [{ id: "go", kind: "act", action: "click", target: { testid: "go" } }] }); assert.equal(upgraded.version, 2); assert.equal(upgraded.steps[0].consent, "confirm"); });
