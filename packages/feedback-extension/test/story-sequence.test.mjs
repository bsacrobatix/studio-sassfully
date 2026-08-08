import test from "node:test";
import assert from "node:assert/strict";
import { isLinkedInUsResultsUrl, validateStoryCommand } from "../ext/story-bridge-policy.mjs";

test("paired-tab navigation has no page-specific workflow gate", () => {
  assert.equal(validateStoryCommand({ action: "navigate", url: "https://www.linkedin.com/jobs/view/123" }).ok, true);
  assert.equal(validateStoryCommand({ action: "navigate", url: "https://www.linkedin.com/feed/" }).ok, true);
  assert.equal(isLinkedInUsResultsUrl("https://www.linkedin.com/jobs/search-results/?anything=1"), true);
  assert.equal(validateStoryCommand({ action: "extract" }).ok, true);
});
