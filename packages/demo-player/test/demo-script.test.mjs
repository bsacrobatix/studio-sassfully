import test from "node:test";
import assert from "node:assert/strict";
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
  ];
  for (const candidate of cases) {
    assert.deepEqual(validateDemoScript(candidate), extensionValidate(candidate));
  }
});

// KNOWN DRIFT (integration finding, 2026-08-08): the extension's validator
// gained structured anchor targets (`validDemoTarget()`: spotlight and
// click/fill action.selector accept `{role, name, testid, text, css}` objects,
// resolved role -> testid -> text -> css) in the demo-overlay-quality branch.
// This package was extracted BEFORE that work and still only accepts CSS
// selector strings, so e.g. examples/host-page-demo-tour.json step t7-click-go
// validates in the extension but is rejected here. Transplanting the anchor
// support into this package is a dedicated follow-up task; until then this
// TODO test documents the drift without failing the gate.
test("TODO: package validator accepts structured anchor targets like the extension's", { todo: "anchor-target transplant pending" }, async () => {
  const { validateDemoScript: extensionValidate } = await import("../../feedback-extension/ext/story-bridge-policy.mjs");
  const anchored = script([step({ spotlight: { role: "button", text: "Generate greeting", css: "[data-testid=\"demo-go\"]" } })]);
  assert.equal(extensionValidate(anchored).ok, true, "extension accepts anchor targets");
  assert.deepEqual(validateDemoScript(anchored), extensionValidate(anchored));
});
