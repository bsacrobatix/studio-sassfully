import { isLinkedInUsResultsUrl } from "./story-bridge-policy.mjs";

// location.assign() acknowledges before Chrome commits the navigation. Hold the
// MCP result until the tab URL itself proves the deterministic route arrived;
// this observes only URL metadata and never reads page/job content.
export async function waitForApprovedNavigation({ tabs, tabId, attempts = 100, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let lastUrl = "";
  for (let index = 0; index < attempts; index += 1) {
    const tab = await tabs.get(tabId);
    lastUrl = tab.url ?? "";
    if (isLinkedInUsResultsUrl(lastUrl)) return lastUrl;
    await delay(100);
  }
  throw new Error(`Timed out waiting for the approved LinkedIn Jobs URL${lastUrl ? ` (last URL: ${new URL(lastUrl).origin}${new URL(lastUrl).pathname})` : ""}`);
}
