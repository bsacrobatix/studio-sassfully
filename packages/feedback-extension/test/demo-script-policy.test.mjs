import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEMO_SCRIPT_MAX_STEPS, DEMO_SCRIPT_VERSION, isLoopbackDemoOrigin, isStoryPairableUrl,
  validateDemoScript, validateStoryCommand,
} from "../ext/story-bridge-policy.mjs";

const step = (extra = {}) => ({ caption: "hi", ...extra });
const script = (steps) => ({ version: DEMO_SCRIPT_VERSION, steps });

test("demo_run and demo_stop are valid story commands", () => {
  assert.equal(validateStoryCommand({ action: "demo_run", script: script([step()]) }).ok, true);
  assert.equal(validateStoryCommand({ action: "demo_stop" }).ok, true);
  assert.equal(validateStoryCommand({ action: "demo_run" }).ok, false, "demo_run without a script is rejected");
});

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

test("the checked-in sample host-page demo script is valid", async () => {
  const sample = JSON.parse(await readFile(new URL("../examples/host-page-demo.json", import.meta.url), "utf8"));
  assert.equal(validateStoryCommand({ action: "demo_run", script: sample }).ok, true);
});

test("loopback demo host is pairable alongside LinkedIn", () => {
  assert.equal(isLoopbackDemoOrigin("http://127.0.0.1:7893"), true);
  assert.equal(isLoopbackDemoOrigin("http://127.0.0.1"), true);
  assert.equal(isLoopbackDemoOrigin("http://localhost:7893"), false);
  assert.equal(isLoopbackDemoOrigin("https://127.0.0.1.evil.test"), false);
  assert.equal(isStoryPairableUrl("http://127.0.0.1:7893/examples/host-page/index.html"), true);
  assert.equal(isStoryPairableUrl("https://www.linkedin.com/feed/"), true);
  assert.equal(isStoryPairableUrl("https://example.com/"), false);
});
