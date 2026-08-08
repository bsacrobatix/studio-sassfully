import test from "node:test";
import assert from "node:assert/strict";
import { runScriptSteps } from "../ext/story-script.mjs";

const recordedFixture = { provenance: "local replay-derived interaction fixture", steps: [
  { action: "navigate", url: "https://www.linkedin.com/jobs/search-results/?keywords=design" },
  { action: "fill", selector: "input[aria-label='Search by title']", text: "product designer" },
  { action: "click", selector: "button[aria-label='Search']" },
  { action: "press", key: "ENTER" }, { action: "extract", selector: ".job-card-container" },
] };

test("local replay-derived script runs ordered generic interactions", async () => {
  const seen = [];
  const result = await runScriptSteps({ steps: recordedFixture.steps, execute: async (step) => { seen.push(step); return { ok: step.action }; } });
  assert.deepEqual(seen.map((step) => step.action), ["navigate", "fill", "click", "press", "extract"]);
  assert.deepEqual(result.map((item) => item.result.ok), ["navigate", "fill", "click", "press", "extract"]);
});

test("script stops at the first useful failure and labels its step", async () => {
  await assert.rejects(() => runScriptSteps({ steps: recordedFixture.steps, execute: async (step) => {
    if (step.action === "click") throw new Error("target was not found in the paired tab");
    return { ok: true };
  } }), /step 3 \(click\): target was not found/);
});
