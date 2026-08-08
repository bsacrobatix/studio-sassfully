// background.mjs — per-origin enablement registry, dynamic content-script
// registration (req-zero-integration-capture: nothing injects on an origin
// the user has not enabled), the badge state machine
// (req-recording-visibility), and the draft stash handed from a page's
// content script to the dedicated review tab.
import { idbBackend } from "./lib/idb-backend.mjs";
import { AUTONOMOUS_JOBS_SESSION, DEFAULT_BRIDGE_PORT, isStoryPairableUrl, LINKEDIN_ORIGIN, parsePairingToken, validateStoryCommand } from "./story-bridge-policy.mjs";
import { ensureStoryReceiver } from "./story-receiver.mjs";
import { appendStoryAudit, makeStoryAuditEntry } from "./story-audit.mjs";
import { runScriptSteps } from "./story-script.mjs";

const drafts = idbBackend({ store: "drafts" });

const BADGES = {
  off: { text: "", color: "#666666" },
  ring: { text: "●", color: "#2e7d32" },
  rec: { text: "REC", color: "#c62828" },
  sdk: { text: "SDK", color: "#1565c0" },
};

const getOrigins = async () => (await chrome.storage.local.get("origins")).origins ?? {};
const getStoryBridge = async () => (await chrome.storage.local.get("storyBridge")).storyBridge ?? null;

let storySocket = null;
let reconnectTimer = null;
// Live socket truth for the popup: stored config says "pairing exists",
// THIS says whether the bridge is actually reachable right now. Worker
// restarts reset it to "closed", which is honest until reconnect runs.
let bridgeLive = { status: "closed", lastError: null, lastConnectedTs: null };
const RECONNECT_ALARM = "story-bridge-reconnect";

function closeStorySocket() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (storySocket) storySocket.close();
  storySocket = null;
}

function sendStory(message) {
  if (storySocket?.readyState === WebSocket.OPEN) storySocket.send(JSON.stringify(message));
}

function waitForPairedTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error("paired tab did not finish navigation")); }, timeoutMs);
    const listener = (changedTabId, changeInfo) => {
      if (changedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runStoryCommand(message) {
  const bridge = await getStoryBridge();
  const check = validateStoryCommand(message.command);
  const audit = async (status, detail = null) => appendStoryAudit(chrome.storage.local, makeStoryAuditEntry({ requestId: message.id, action: message.command?.action ?? "unknown", status, detail }));
  if (!bridge?.enabled || bridge.mode !== AUTONOMOUS_JOBS_SESSION || !check.ok) { await audit("rejected", check.error ?? "Story bridge is not paired"); return sendStory({ type: "result", id: message.id, ok: false, error: check.error ?? "Story bridge is not paired" }); }
  let tab;
  try { tab = await chrome.tabs.get(bridge.tabId); } catch { await audit("failed", "paired tab no longer exists"); return sendStory({ type: "result", id: message.id, ok: false, error: "The paired tab no longer exists" }); }
  try {
    const execute = async (command) => {
      if (command.action === "navigate") {
        const loaded = waitForPairedTabLoad(tab.id);
        await chrome.tabs.update(tab.id, { url: command.url });
        await loaded;
        return { navigating: true, url: command.url };
      }
      await ensureStoryReceiver({ tabs: chrome.tabs, scripting: chrome.scripting, tabId: tab.id });
      const reply = await chrome.tabs.sendMessage(tab.id, { type: "story-command", command, requestId: message.id });
      if (!reply?.ok) throw new Error(reply?.error ?? "paired tab rejected command");
      return reply.result;
    };
    const result = message.command.action === "run_script"
      ? { ok: true, result: { steps: await runScriptSteps({ steps: message.command.steps, execute }) } }
      : { ok: true, result: await execute(message.command) };
    await audit(result?.ok ? "ok" : "failed", result?.ok ? null : result?.error ?? "content command failed");
    sendStory({ type: "result", id: message.id, ...result });
  } catch (error) { await audit("failed", error.message); sendStory({ type: "result", id: message.id, ok: false, error: error.message }); }
}

async function connectStoryBridge() {
  closeStorySocket();
  const bridge = await getStoryBridge();
  if (!bridge?.enabled || !bridge.code) { bridgeLive = { status: "closed", lastError: null, lastConnectedTs: bridgeLive.lastConnectedTs }; return; }
  const port = bridge.port ?? DEFAULT_BRIDGE_PORT;
  bridgeLive = { ...bridgeLive, status: "connecting" };
  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge?code=${encodeURIComponent(bridge.code)}`);
  storySocket = socket;
  socket.addEventListener("open", () => {
    if (storySocket !== socket) return;
    bridgeLive = { status: "open", lastError: null, lastConnectedTs: Date.now() };
    sendStory({ type: "ready", tabId: bridge.tabId, origin: LINKEDIN_ORIGIN });
  });
  socket.addEventListener("error", () => {
    if (storySocket !== socket) return;
    bridgeLive = { ...bridgeLive, lastError: `no bridge answering on ws://127.0.0.1:${port} (wrong token, bridge not running, or slot busy)` };
  });
  socket.addEventListener("message", (event) => {
    try { const message = JSON.parse(event.data); if (message.type === "command" && typeof message.id === "string") runStoryCommand(message); } catch { /* malformed local input is ignored */ }
  });
  socket.addEventListener("close", () => {
    if (storySocket !== socket) return;
    bridgeLive = { ...bridgeLive, status: "closed" };
    // Fast retry while the worker lives; the chrome.alarms backstop below
    // covers the case where MV3 kills this timer with the worker.
    reconnectTimer = setTimeout(connectStoryBridge, 3000);
  });
}

// MV3 backstop: setTimeout dies with the service worker, alarms do not.
// Every ~30s, if a pairing is stored but the socket is not open/connecting,
// dial again. The alarm clears itself when the pairing is gone.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  const bridge = await getStoryBridge();
  if (!bridge?.enabled) { await chrome.alarms.clear(RECONNECT_ALARM); return; }
  if (storySocket && (storySocket.readyState === WebSocket.OPEN || storySocket.readyState === WebSocket.CONNECTING)) return;
  await connectStoryBridge();
});

function ensureReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

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

async function resumeStoryBridge() {
  if ((await getStoryBridge())?.enabled) ensureReconnectAlarm();
  await connectStoryBridge();
}
chrome.runtime.onInstalled.addListener(async () => { await syncRegisteredScripts(await getOrigins()); await resumeStoryBridge(); });
chrome.runtime.onStartup.addListener(() => { resumeStoryBridge(); });

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
    if (msg?.type === "pair-story-bridge") {
      const tab = await chrome.tabs.get(msg.tabId);
      if (!isStoryPairableUrl(tab.url)) { sendResponse({ ok: false, error: "Open a www.linkedin.com tab or the 127.0.0.1 demo host page first." }); return; }
      const parsed = parsePairingToken(msg.token);
      if (!parsed.ok) { sendResponse({ ok: false, error: parsed.error }); return; }
      try { await ensureStoryReceiver({ tabs: chrome.tabs, scripting: chrome.scripting, tabId: msg.tabId }); } catch (error) { sendResponse({ ok: false, error: error.message }); return; }
      await chrome.storage.local.set({ storyBridge: { enabled: true, mode: AUTONOMOUS_JOBS_SESSION, tabId: msg.tabId, code: parsed.code, port: parsed.port } });
      ensureReconnectAlarm();
      await connectStoryBridge();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === "unpair-story-bridge") { await chrome.storage.local.remove("storyBridge"); closeStorySocket(); bridgeLive = { status: "closed", lastError: null, lastConnectedTs: null }; await chrome.alarms.clear(RECONNECT_ALARM); sendResponse({ ok: true }); return; }
    if (msg?.type === "story-bridge-state") { sendResponse({ bridge: await getStoryBridge(), live: { ...bridgeLive } }); return; }
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
