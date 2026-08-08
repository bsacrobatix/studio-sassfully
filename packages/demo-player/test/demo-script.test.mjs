import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEMO_SCRIPT_MAX_STEPS, DEMO_SCRIPT_VERSION, validateDemoScript } from "../src/demo-script.mjs";

const step = (extra = {}) => ({ caption: "hi", ...extra });
const script = (steps) => ({ version: DEMO_SCRIPT_VERSION, steps });

test("demo script validation bounds steps and string fields", () => {
  assert.equal(validateDemoScript(script([step({ spotlight: "h1", narration: "hello", dwellMs: 500 })])).ok, true);
  assert.equal(validateDemoScript({ steps: [step()] }).ok, true, "version is optional");
  assert.equal(validateDemoScript(null).ok, false);
  assert.equal(validateDemoScript({ version: "other/v9", steps: [step()] }).ok, false);
  assert.equal(validateDemoScript(script([])).ok, false);
  assert.equal(validateDemoScript(script(Array.from({ length: DEMO_SCRIPT_MAX_STEPS + 1 }, () => step()))).ok, false, "step count is capped");
  assert.equal(validateDemoScript(script(Array.from({ length: DEMO_SCRIPT_MAX_STEPS }, () => step()))).ok, true);
  assert.equal(validateDemoScript(script([{}])).ok, false, "a step must do something");
  assert.equal(validateDemoScript(script([step({ caption: "x".repeat(501) })])).ok, false);
  assert.equal(validateDemoScript(script([step({ narration: "x".repeat(2001) })])).ok, false);
  assert.equal(validateDemoScript(script([step({ spotlight: "x".repeat(501) })])).ok, false);
  assert.equal(validateDemoScript(script([step({ dwellMs: -1 })])).ok, false);
  assert.equal(validateDemoScript(script([step({ dwellMs: 60001 })])).ok, false);
  assert.equal(validateDemoScript(script([step({ dwellMs: "800" })])).ok, false);
  assert.equal(validateDemoScript(script([step({ dim: "no" })])).ok, false);
});

test("structured anchor targets are accepted with bounded fields, strings stay valid", () => {
  const anchor = { role: "button", name: "Generate greeting" };
  assert.equal(validateDemoScript(script([step({ spotlight: anchor })])).ok, true);
  assert.equal(validateDemoScript(script([step({ spotlight: { testid: "greet", css: "#greet" } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ spotlight: { text: "Hello" } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ action: { kind: "click", selector: anchor } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ action: { kind: "fill", selector: { css: "#name" }, value: "Ada" } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ spotlight: {} })])).ok, false, "empty anchor object is rejected");
  assert.equal(validateDemoScript(script([step({ spotlight: { name: "only a name" } })])).ok, false, "name alone cannot locate");
  assert.equal(validateDemoScript(script([step({ spotlight: { role: "button", bogus: "x" } })])).ok, false, "unknown anchor keys are rejected");
  assert.equal(validateDemoScript(script([step({ spotlight: { role: "x".repeat(101) } })])).ok, false, "role is bounded");
  assert.equal(validateDemoScript(script([step({ spotlight: { css: "x".repeat(501) } })])).ok, false, "css is bounded");
  assert.equal(validateDemoScript(script([step({ spotlight: { text: 7 } })])).ok, false, "anchor fields must be strings");
  assert.equal(validateDemoScript(script([step({ spotlight: ["#a"] })])).ok, false, "arrays are not anchors");
  assert.equal(validateDemoScript(script([step({ action: { kind: "click", selector: { name: "nope" } } })])).ok, false);
});

test("demo step actions are limited to bounded click/fill/press", () => {
  assert.equal(validateDemoScript(script([step({ action: { kind: "click", selector: "button" } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ action: { kind: "fill", selector: "input", value: "Ada" } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ action: { kind: "press", value: "Enter" } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ action: { kind: "navigate", selector: "a" } })])).ok, false);
  assert.equal(validateDemoScript(script([step({ action: { kind: "click" } })])).ok, false, "click needs a selector");
  assert.equal(validateDemoScript(script([step({ action: { kind: "fill", selector: "input" } })])).ok, false, "fill needs a value");
  assert.equal(validateDemoScript(script([step({ action: { kind: "press" } })])).ok, false, "press needs a value (the key)");
});

test("voice and bounded stage scenes are accepted, malformed stage payloads are rejected", () => {
  const scene = { type: "stage", stage: { units: { w: 100, h: 50 } }, beats: [] };
  assert.equal(validateDemoScript({ voice: "en-US-AnaNeural", steps: [step({ voice: "en-US-JennyNeural", stage: { scene, anchor: "target", persistent: true } })] }).ok, true);
  assert.equal(validateDemoScript(script([step({ stage: { scene, anchor: { mode: "dock", edge: "bottom-right", size: 0.4 } } })])).ok, true);
  assert.equal(validateDemoScript(script([step({ stage: { scene, unexpected: true } })])).ok, false);
  assert.equal(validateDemoScript(script([step({ stage: { scene, anchor: { mode: "outside" } } })])).ok, false);
  assert.equal(validateDemoScript(script([step({ stage: { scene, persistent: "yes" } })])).ok, false);
  const nova = { id: "nova", src: "/packages/demo-stage/assets/nova-cutout.png", alt: "Nova presenter" };
  assert.equal(validateDemoScript(script([step({ stage: { presenter: nova, persistent: true } })])).ok, true, "a local static presenter may be a stage by itself");
  assert.equal(validateDemoScript(script([step({ stage: { scene, presenter: nova } })])).ok, true, "a cutout may accompany an animated scene");
  assert.equal(validateDemoScript(script([step({ stage: { presenter: { ...nova, src: "https://example.test/nova.png" } } })])).ok, false, "remote cutouts are not a script fetch surface");
  assert.equal(validateDemoScript(script([step({ stage: { presenter: { ...nova, src: "data:image/png;base64,AA" } } })])).ok, false);
  assert.equal(validateDemoScript(script([step({ stage: {} })])).ok, false);
});

test("the extension's validator and this one agree (extraction stays in sync)", async () => {
  const { validateDemoScript: extensionValidate, DEMO_SCRIPT_VERSION: extensionVersion } =
    await import("../../feedback-extension/ext/story-bridge-policy.mjs");
  assert.equal(extensionVersion, DEMO_SCRIPT_VERSION);
  const cases = [
    script([step()]),
    script([{}]),
    script([]),
    { version: "other/v9", steps: [step()] },
    script([step({ action: { kind: "fill", selector: "input", value: "Ada" } })]),
    script([step({ action: { kind: "navigate", selector: "a" } })]),
    // Structured anchor targets (valid and invalid) must agree too — this was
    // the documented extraction drift, now closed.
    script([step({ spotlight: { role: "button", name: "Generate greeting" } })]),
    script([step({ spotlight: { testid: "greet", css: "#greet" } })]),
    script([step({ action: { kind: "click", selector: { role: "button", text: "Generate greeting", css: "[data-testid=\"demo-go\"]" } } })]),
    script([step({ action: { kind: "fill", selector: { css: "#name" }, value: "Ada" } })]),
    script([step({ spotlight: {} })]),
    script([step({ spotlight: { name: "only a name" } })]),
    script([step({ spotlight: { role: "button", bogus: "x" } })]),
    script([step({ spotlight: { role: "x".repeat(101) } })]),
    script([step({ spotlight: ["#a"] })]),
  ];
  for (const candidate of cases) {
    assert.deepEqual(validateDemoScript(candidate), extensionValidate(candidate));
  }
});

// This was the documented extraction drift (TODO test, 2026-08-08): the
// extension's validator gained structured anchor targets before this package
// was extracted. The transplant landed; the former TODO now asserts for real.
test("package validator accepts structured anchor targets like the extension's", async () => {
  const { validateDemoScript: extensionValidate } = await import("../../feedback-extension/ext/story-bridge-policy.mjs");
  const anchored = script([step({ spotlight: { role: "button", text: "Generate greeting", css: "[data-testid=\"demo-go\"]" } })]);
  assert.equal(extensionValidate(anchored).ok, true, "extension accepts anchor targets");
  assert.equal(validateDemoScript(anchored).ok, true, "this package accepts anchor targets");
  assert.deepEqual(validateDemoScript(anchored), extensionValidate(anchored));
});

test("the anchor-using extension example validates in BOTH validators", async () => {
  const tour = JSON.parse(await readFile(new URL("../../feedback-extension/examples/host-page-demo-tour.json", import.meta.url), "utf8"));
  assert.ok(tour.steps.some((s) => typeof s.action?.selector === "object"), "the tour example exercises a structured anchor");
  const { validateDemoScript: extensionValidate } = await import("../../feedback-extension/ext/story-bridge-policy.mjs");
  assert.deepEqual(validateDemoScript(tour), { ok: true });
  assert.deepEqual(extensionValidate(tour), { ok: true });
});
