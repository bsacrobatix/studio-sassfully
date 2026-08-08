import test from "node:test";
import assert from "node:assert/strict";
import { waitForApprovedNavigation } from "../ext/story-navigation.mjs";
import { remoteReadiness, selectVisibleRemoteFilter } from "../ext/content/story-confirm.mjs";

test("deterministic local journey: navigate settles, Remote appears, select_remote succeeds, readiness remains result-free", async () => {
  const destination = "https://www.linkedin.com/jobs/search-results/?keywords=designer&currentJobId=123";
  const urls = ["https://www.linkedin.com/feed/", destination]; let reads = 0; let buttonReads = 0; const clicks = [];
  const button = { getClientRects: () => [1], click: () => clicks.push("filter") };
  const option = { getClientRects: () => [1], getAttribute: () => "false", click: () => clicks.push("remote") };
  const document = { querySelector: (selector) => {
    if (selector === 'button[aria-label="Remote"]') return ++buttonReads > 1 ? button : null;
    return selector.includes('[role="checkbox"][aria-label="Remote"]') ? option : null;
  } };
  assert.equal(await waitForApprovedNavigation({ tabs: { get: async () => ({ url: urls[reads++] }) }, tabId: 4, delay: async () => {} }), destination);
  assert.deepEqual(remoteReadiness(document), { remoteFilterReady: false, remoteChoiceReady: true });
  assert.deepEqual(await selectVisibleRemoteFilter(document, async () => {}), { remoteSelected: true, alreadySelected: false });
  assert.deepEqual(clicks, ["filter", "remote"]);
});
