// background.mjs — per-origin enablement registry, dynamic content-script
// registration (req-zero-integration-capture: nothing injects on an origin
// the user has not enabled), the badge state machine
// (req-recording-visibility), and the draft stash handed from a page's
// content script to the dedicated review tab.
import { idbBackend } from "./lib/idb-backend.mjs";

const drafts = idbBackend({ store: "drafts" });

const BADGES = {
  off: { text: "", color: "#666666" },
  ring: { text: "●", color: "#2e7d32" },
  rec: { text: "REC", color: "#c62828" },
  sdk: { text: "SDK", color: "#1565c0" },
};

const getOrigins = async () => (await chrome.storage.local.get("origins")).origins ?? {};

async function syncRegisteredScripts(origins) {
  const matches = Object.entries(origins).filter(([, config]) => config.enabled).map(([origin]) => `${origin}/*`);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((script) => script.id) });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    // rrweb loads declaratively (page-CSP-proof); main-world.js starts it on
    // request and relays events + telemetry to the isolated world.
    { id: "sassfully-main-world", world: "MAIN", js: ["vendor/rrweb-record.iife.js", "main-world.js"], matches, runAt: "document_start", persistAcrossSessions: true },
    { id: "sassfully-loader", js: ["content-loader.js"], matches, runAt: "document_idle", persistAcrossSessions: true },
  ]);
}

chrome.runtime.onInstalled.addListener(async () => { await syncRegisteredScripts(await getOrigins()); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "get-state") {
      const origins = await getOrigins();
      const { intake } = await chrome.storage.local.get("intake");
      sendResponse({ config: origins[msg.origin] ?? { enabled: false, mode: "ring" }, intake: intake ?? null, version: chrome.runtime.getManifest().version });
      return;
    }
    if (msg?.type === "set-origin") {
      const origins = await getOrigins();
      origins[msg.origin] = { ...(origins[msg.origin] ?? { mode: "ring" }), ...msg.config };
      await chrome.storage.local.set({ origins });
      await syncRegisteredScripts(origins);
      sendResponse({ ok: true, config: origins[msg.origin] });
      return;
    }
    if (msg?.type === "badge") {
      const tabId = sender?.tab?.id ?? msg.tabId;
      const badge = BADGES[msg.state] ?? BADGES.off;
      if (tabId != null) {
        await chrome.action.setBadgeText({ tabId, text: badge.text });
        await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color });
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "stash-draft") {
      const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await drafts.put(id, msg.draft);
      await chrome.tabs.create({ url: chrome.runtime.getURL(`review/review.html#${id}`) });
      sendResponse({ ok: true, id });
      return;
    }
    if (msg?.type === "load-draft") { sendResponse({ draft: await drafts.get(msg.id) }); return; }
    if (msg?.type === "drop-draft") { await drafts.delete(msg.id); sendResponse({ ok: true }); return; }
    sendResponse({ error: `unknown message ${msg?.type}` });
  })();
  return true;
});
