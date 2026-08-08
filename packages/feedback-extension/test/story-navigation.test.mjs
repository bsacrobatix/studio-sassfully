import test from "node:test";
import assert from "node:assert/strict";
import { waitForApprovedNavigation } from "../ext/story-navigation.mjs";

const approved = "https://www.linkedin.com/jobs/search-results/?keywords=product%20designer&geoId=103644278&f_WT=2";

test("navigate completion waits for the exact approved URL before resolving", async () => {
  const urls = ["https://www.linkedin.com/feed/", "https://www.linkedin.com/jobs/search-results/?geoId=103644278", approved];
  let reads = 0;
  const url = await waitForApprovedNavigation({ tabs: { get: async () => ({ url: urls[reads++] }) }, tabId: 3, delay: async () => {} });
  assert.equal(url, urls[1]);
  assert.equal(reads, 2);
  assert.doesNotMatch(url, /f_WT=2/);
});

test("navigate completion times out instead of accepting an incomplete route", async () => {
  await assert.rejects(() => waitForApprovedNavigation({ tabs: { get: async () => ({ url: "https://www.linkedin.com/feed/" }) }, tabId: 3, attempts: 2, delay: async () => {} }), /Timed out waiting/);
});
