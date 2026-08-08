import test from "node:test";
import assert from "node:assert/strict";
import { runAutonomousStoryCommand } from "../ext/content/story-confirm.mjs";

test("autonomous paired-tab command executes immediately without creating a confirmation modal", async () => {
  const events = [];
  const input = { focus: () => events.push("focus"), dispatchEvent: (event) => events.push(event.type) };
  const document = { querySelector: () => input, querySelectorAll: () => [] };
  const result = await runAutonomousStoryCommand({ document, location: { href: "https://www.linkedin.com/jobs/" }, requestId: "req-1", command: { action: "fill", selector: "input", text: "design" } });
  assert.deepEqual(result, { requestId: "req-1", filled: true });
  assert.equal(input.value, "design");
  assert.deepEqual(events, ["focus", "input", "change"]);
  assert.equal(document.createElement, undefined, "no confirmation UI was created");
});

test("autonomous extraction reads only visible matching nodes and can mark evidence", async () => {
  const visible = { getClientRects: () => [1], textContent: " First card " };
  const hidden = { getClientRects: () => [], textContent: "Hidden" };
  const document = { querySelectorAll: () => [visible, hidden] };
  const result = await runAutonomousStoryCommand({ document, location: { href: "https://www.linkedin.com/jobs/" }, requestId: "req-2", command: { action: "extract", selector: ".card", captureEvidence: true } });
  assert.deepEqual(result.text, ["First card"]);
  assert.equal(result.requestId, "req-2");
  assert.equal(result.evidence.source, "paired-tab-visible-dom");
});
