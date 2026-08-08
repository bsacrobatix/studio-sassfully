import test from "node:test";
import assert from "node:assert/strict";
import { storyBridgeSection } from "../ext/popup/story-bridge-view.mjs";

const allowed = "https://www.linkedin.com/jobs/search-results/?keywords=product%20designer&geoId=103644278&f_WT=2";

test("enabled direct v0 search-results URL visibly renders the Pair panel", () => {
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: allowed, config: { enabled: true }, bridge: null, live: null, tabId: 5 });
  assert.match(html, /Local Kitsoki Story bridge/);
  assert.match(html, /Pair this LinkedIn Jobs tab/);
});

test("enabled LinkedIn tabs can pair before navigation", () => {
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: "https://www.linkedin.com/jobs/search-results/?f_EA=true", config: { enabled: true }, bridge: null, live: null, tabId: 5 });
  assert.match(html, /Local Kitsoki Story bridge/);
  assert.match(html, /id="pair-story"/);
});

test("pairing form takes ONE token field and no separate port input", () => {
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: allowed, config: { enabled: true }, bridge: null, live: null, tabId: 5 });
  assert.match(html, /id="story-token"/);
  assert.doesNotMatch(html, /id="story-code"/);
  assert.doesNotMatch(html, /id="story-port"/);
});

test("a stored pairing with an open socket renders as paired AND connected", () => {
  const bridge = { enabled: true, tabId: 5, code: "abcdefghijklmnopqrstuvwxyzABCDEF12", port: 8931 };
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: allowed, config: { enabled: true }, bridge, live: { status: "open", lastError: null, lastConnectedTs: Date.now() }, tabId: 5 });
  assert.match(html, /Paired · connected/);
  assert.match(html, /id="unpair-story"/);
});

test("a stored pairing with a dead socket is never rendered as connected", () => {
  const bridge = { enabled: true, tabId: 5, code: "abcdefghijklmnopqrstuvwxyzABCDEF12", port: 8931 };
  for (const live of [null, { status: "closed", lastError: null }, { status: "connecting", lastError: null }]) {
    const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: allowed, config: { enabled: true }, bridge, live, tabId: 5 });
    assert.match(html, /Paired · NOT connected \(retrying…\)/, JSON.stringify(live));
    assert.doesNotMatch(html, /Paired · connected/, JSON.stringify(live));
    assert.match(html, /id="unpair-story"/);
  }
});

test("the last connection error is surfaced next to the disconnected state", () => {
  const bridge = { enabled: true, tabId: 5, code: "abcdefghijklmnopqrstuvwxyzABCDEF12", port: 8931 };
  const html = storyBridgeSection({ origin: "https://www.linkedin.com", url: allowed, config: { enabled: true }, bridge, live: { status: "closed", lastError: "no bridge answering on ws://127.0.0.1:8931 (wrong token, bridge not running, or slot busy)" }, tabId: 5 });
  assert.match(html, /no bridge answering on ws:\/\/127\.0\.0\.1:8931/);
});
