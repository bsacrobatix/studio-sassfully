import test from "node:test";
import assert from "node:assert/strict";
import { buildJobsSearchUrl, isLinkedInOriginUrl, isLinkedInSearchUrl, isLinkedInUsResultsUrl, validateStoryCommand } from "../ext/story-bridge-policy.mjs";

test("Story bridge only recognizes the LinkedIn Jobs search route", () => {
  assert.equal(isLinkedInOriginUrl("https://www.linkedin.com/feed/"), true);
  assert.equal(isLinkedInOriginUrl("https://www.linkedin.com.evil.test/feed/"), false);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search/"), false);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search-results/?keywords=product%20designer&geoId=103644278&f_WT=2"), true);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search-results/?keywords=product%20designer&geoId=103644278"), true);
  assert.equal(isLinkedInUsResultsUrl("https://www.linkedin.com/jobs/search-results/?geoId=103644278"), true, "canonical base route is valid for post-navigation actions");
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search-results/?geoId=103644278"), true, "it is also an allowed route navigation");
  const canonical = "https://www.linkedin.com/jobs/search-results/?keywords=product%20designer&geoId=103644278&currentJobId=123&origin=JOB_SEARCH_PAGE_SEARCH_BUTTON&referral=abc";
  assert.equal(isLinkedInUsResultsUrl(canonical), true, "post-navigation recognition tolerates LinkedIn canonical context");
  assert.equal(isLinkedInSearchUrl(canonical), true, "route navigation tolerates user query parameters");
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search/?keywords=design"), false);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/view/123"), false);
  assert.equal(isLinkedInSearchUrl("https://linkedin.com/jobs/search"), false);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com.evil.test/jobs/search"), false);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search-results/?geoId=us&f_WT=2"), true);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search-results/?geoId=103644278&f_WT=1"), true);
  assert.equal(isLinkedInSearchUrl("https://www.linkedin.com/jobs/search-results/?geoId=103644278&f_EA=true"), true);
});

test("paired-tab command contract exposes the simple autonomous MCP surface", () => {
  assert.equal(validateStoryCommand({ action: "snapshot" }).ok, true);
  assert.equal(validateStoryCommand({ action: "navigate", url: "https://example.test/anything" }).ok, true);
  assert.equal(validateStoryCommand({ action: "click", selector: "button.apply" }).ok, true);
  assert.equal(validateStoryCommand({ action: "click", target: "Submit" }).ok, true);
  assert.equal(validateStoryCommand({ action: "fill", selector: "input[name=q]", text: "product designer" }).ok, true);
  assert.equal(validateStoryCommand({ action: "press", key: "ENTER" }).ok, true);
  assert.equal(validateStoryCommand({ action: "extract", selector: ".card", captureEvidence: true }).ok, true);
  assert.equal(validateStoryCommand({ action: "run_script", steps: [{ action: "press", key: "ENTER" }] }).ok, true);
  assert.equal(validateStoryCommand({ action: "snapshot", captureEvidence: true, traceId: "agent-1" }).ok, true, "snapshot ignores optional caller metadata");
  assert.equal(validateStoryCommand({ action: "navigate", url: "https://www.linkedin.com/jobs/", captureEvidence: true }).ok, true, "navigate ignores optional caller metadata");
  for (const command of [
    { action: "click" }, { action: "fill", selector: "input" }, { action: "press" },
    { action: "extract", captureEvidence: "yes" }, { action: "run_script", steps: [] }, { action: "anything" },
  ]) assert.equal(validateStoryCommand(command).ok, false, JSON.stringify(command));
});
