// Isolated-world entry: owns the ring (fed by the MAIN-world rrweb pump),
// the telemetry client, the host-SDK bridge, and the standalone overlay.
// Loaded only on origins the user enabled (background registers the loader
// per-origin). A successful bridge accept removes the standalone overlay —
// the host SDK owns the flow on that page (req-ext-bridge-enrich).
import { createRecordingRing, replayEvidenceItems } from "./core/ring.mjs";
import { createTelemetryClient, telemetryProviders } from "./core/telemetry-main.mjs";
import { createExtensionBridge } from "./core/bridge.mjs";
import { mountOverlay } from "./overlay.mjs";
import { runAutonomousStoryCommand } from "./story-confirm.mjs";

const RRWEB_CHANNEL = "sassfully-ext/rrweb/v1";
const origin = location.origin;
const { config, version } = await chrome.runtime.sendMessage({ type: "get-state", origin });

if (config?.enabled) {
  const ring = createRecordingRing({});
  let telemetryOk = true;
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.$channel !== RRWEB_CHANNEL || event.source !== window) return;
    if (msg.type === "rrweb-event") ring.push(msg.event);
    else if (msg.type === "telemetry-unavailable") telemetryOk = false;
  });
  window.postMessage({ $channel: RRWEB_CHANNEL, type: "telemetry-boot", moduleUrl: chrome.runtime.getURL("content/core/telemetry-main.mjs") }, "*");
  const telemetry = createTelemetryClient({ window });

  let recordingState = "off";
  const setBadge = (state) => { recordingState = state; chrome.runtime.sendMessage({ type: "badge", state }).catch(() => {}); };
  const startRecording = (state) => { window.postMessage({ $channel: RRWEB_CHANNEL, type: "rrweb-start" }, "*"); setBadge(state); };
  const stopRecording = () => { window.postMessage({ $channel: RRWEB_CHANNEL, type: "rrweb-stop" }, "*"); ring.clear(); setBadge(bridge.bridged ? "sdk" : "off"); };
  if (config.mode === "ring") startRecording("ring");

  const replayProvider = {
    id: "ext-replay",
    label: "Session replay",
    description: "Trailing replay window from the local recording ring",
    capture() {
      const snapshot = ring.snapshot({ lastMs: config.replayWindowMs ?? 120000 });
      return replayEvidenceItems(snapshot, { clipId: `clip-${snapshot.endTs ?? "empty"}` });
    },
  };
  const providers = [replayProvider, ...(telemetryOk ? telemetryProviders(telemetry) : [])];

  let overlay = null;
  const bridge = createExtensionBridge({
    window,
    providers,
    onAccepted() { overlay?.unmount(); overlay = null; setBadge("sdk"); },
  });

  const openReview = async ({ kind, userText, bbox, includeReplay }) => {
    const evidence = [];
    if (includeReplay) evidence.push(...replayProvider.capture());
    for (const provider of (telemetryOk ? telemetryProviders(telemetry) : [])) {
      try { evidence.push(...await provider.capture()); } catch { /* telemetry is best-effort evidence */ }
    }
    await chrome.runtime.sendMessage({ type: "stash-draft", draft: { kind, url: location.href, userText, bbox, extensionVersion: version, evidence } });
  };
  if (!bridge.bridged) overlay = mountOverlay({ document, onSubmit: openReview });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "story-ping") sendResponse({ ok: true });
    else if (msg?.type === "recording") { msg.on ? startRecording("rec") : stopRecording(); sendResponse({ ok: true, state: recordingState }); }
    else if (msg?.type === "ring-stats") sendResponse({ stats: ring.stats(), state: recordingState, bridged: bridge.bridged });
    else if (msg?.type === "story-command") {
      runAutonomousStoryCommand({ document, location, command: msg.command, requestId: msg.requestId })
        .then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });
}
