// telemetry-main.mjs — the two halves of the in-page telemetry relay. The
// existing browser-capture providers monkey-patch window.fetch/console, which
// only observes the page's real traffic from the MAIN world; the extension's
// isolated world requests captures over window.postMessage. Messages never
// leave the page's own window — a $channel tag plus same-window source check
// scope delivery, and redaction happened at capture time inside
// createBrowserEvidenceCapture before anything crosses worlds.
import { createBrowserEvidenceCapture } from "./deps.mjs";

export const TELEMETRY_CHANNEL = "sassfully-ext/telemetry/v1";

/** MAIN-world half: instruments the page and answers capture requests. */
export function startMainTelemetry({ window: win, channel = TELEMETRY_CHANNEL, maxEntries } = {}) {
  if (!win) throw new TypeError("telemetry: window is required");
  const capture = createBrowserEvidenceCapture({ window: win, ...(maxEntries === undefined ? {} : { maxEntries }) });
  const byId = new Map(capture.providers.map((provider) => [provider.id, provider]));
  const onMessage = (event) => {
    const msg = event.data;
    if (!msg || msg.$channel !== channel || msg.type !== "capture-request") return;
    if (event.source && event.source !== win) return;
    let reply;
    try {
      const provider = byId.get(msg.id);
      if (!provider) reply = { $channel: channel, type: "capture-error", nonce: msg.nonce, error: `unknown provider ${msg.id}` };
      else {
        const captured = provider.capture();
        reply = { $channel: channel, type: "capture-response", nonce: msg.nonce, items: (Array.isArray(captured) ? captured : [captured]).filter(Boolean) };
      }
    } catch (error) { reply = { $channel: channel, type: "capture-error", nonce: msg.nonce, error: error?.message ?? String(error) }; }
    win.postMessage(reply, "*");
  };
  win.addEventListener("message", onMessage);
  return { providerIds: [...byId.keys()], stop() { win.removeEventListener("message", onMessage); capture.dispose(); } };
}

/** Isolated-world half: request/response client keyed by nonce. */
export function createTelemetryClient({ window: win, channel = TELEMETRY_CHANNEL, timeoutMs = 3000 } = {}) {
  if (!win) throw new TypeError("telemetry: window is required");
  let counter = 0; const pending = new Map();
  const onMessage = (event) => {
    const msg = event.data;
    if (!msg || msg.$channel !== channel) return;
    if (msg.type !== "capture-response" && msg.type !== "capture-error") return;
    if (event.source && event.source !== win) return;
    const request = pending.get(msg.nonce);
    if (!request) return;
    pending.delete(msg.nonce); clearTimeout(request.timer);
    if (msg.type === "capture-response") request.resolve(msg.items);
    else if (msg.type === "capture-error") request.reject(new Error(msg.error));
  };
  win.addEventListener("message", onMessage);
  return {
    capture(id) {
      const nonce = `t${++counter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(nonce); reject(new Error(`telemetry: capture ${id} timed out`)); }, timeoutMs);
        pending.set(nonce, { resolve, reject, timer });
        win.postMessage({ $channel: channel, type: "capture-request", id, nonce }, "*");
      });
    },
    stop() {
      win.removeEventListener("message", onMessage);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("telemetry: client stopped")); }
      pending.clear();
    },
  };
}

const TELEMETRY_PROVIDER_META = {
  network: { id: "ext-network", label: "Network summary" },
  console: { id: "ext-console", label: "Console warnings and errors" },
  error: { id: "ext-error", label: "Browser errors" },
};

/** Reporter-shaped providers over a telemetry client. */
export function telemetryProviders(client, ids = Object.keys(TELEMETRY_PROVIDER_META)) {
  return ids.map((id) => ({
    ...TELEMETRY_PROVIDER_META[id],
    description: "Captured in-page, redacted at capture time",
    capture: () => client.capture(id),
  }));
}
