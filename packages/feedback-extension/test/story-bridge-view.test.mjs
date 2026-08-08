import test from "node:test";
import assert from "node:assert/strict";
import { storyBridgeSection } from "../ext/popup/story-bridge-view.mjs";

const allowed = "https://www.linkedin.com/jobs/search-results/?keywords=product%20designer&geoId=103644278&f_WT=2";

test("enabled direct v0 search-results URL visibly renders the Pair panel", () => {
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: allowed, config: { enabled: true }, bridge: null, tabId: 5 });
  assert.match(html, /Local Kitsoki Story bridge/);
  assert.match(html, /Pair this LinkedIn Jobs tab/);
});

test("enabled LinkedIn tabs can pair before navigation", () => {
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: "https://www.linkedin.com/jobs/search-results/?f_EA=true", config: { enabled: true }, bridge: null, tabId: 5 });
  assert.match(html, /Local Kitsoki Story bridge/);
  assert.match(html, /id="pair-story"/);
});
